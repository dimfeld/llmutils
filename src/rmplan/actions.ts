import { select } from '@inquirer/prompts';
import { generateText } from 'ai';
import chalk from 'chalk';
import os from 'node:os';
import path from 'path';
import yaml from 'yaml';
import { Resolver } from '../dependency_graph/resolve.js';
import { ImportWalker } from '../dependency_graph/walk_imports.js';
import { boldMarkdownHeaders, error, log, warn, writeStderr, writeStdout } from '../logging.js';
import { findAdditionalDocs, getChangedFiles } from '../rmfilter/additional_docs.js';
import { extractFileReferencesFromInstructions } from '../rmfilter/instructions.js';
import { commitAll, getGitRoot, quiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { Extractor } from '../treesitter/extract.js';
import type { PostApplyCommand, RmplanConfig } from './configSchema.js';
import type { PlanSchema } from './planSchema.js';
import { phaseSchema, planSchema } from './planSchema.js';
import { fixYaml } from './fix_yaml.js';
import type { PhaseGenerationContext } from './prompt.js';
import { generatePhaseStepsPrompt } from './prompt.js';
import { convertMarkdownToYaml, findYamlStart } from './process_markdown.js';
import { createModel } from '../common/model_factory.js';
import { DEFAULT_RUN_MODEL } from '../common/run_and_apply.js';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.js';
import { readAllPlans } from './plans.js';

export interface PrepareNextStepOptions {
  rmfilter?: boolean;
  previous?: boolean;
  withImports?: boolean;
  withAllImports?: boolean;
  withImporters?: boolean;
  selectSteps?: boolean | 'all';
  rmfilterArgs?: string[];
  model?: string;
  autofind?: boolean;
  filePathPrefix?: string;
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
  config: RmplanConfig,
  planFile: string,
  options: PrepareNextStepOptions = {},
  baseDir?: string
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
    withImporters = false,
    selectSteps = true,
    rmfilterArgs: initialRmfilterArgs = [],
    autofind = false,
    model,
  } = options;

  if (withImports && withAllImports) {
    throw new Error('Cannot use both --with-imports and --with-all-imports. Please choose one.');
  }

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
  const performImportAnalysis = withImports || withAllImports || withImporters;

  // Strip parenthetical comments from filenames (e.g., "file.ts (New File)" -> "file.ts")
  const cleanFiles = activeTask.files.map((file) => file.replace(/\s*\([^)]*\)\s*$/, '').trim());

  const gitRoot = await getGitRoot(baseDir);
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
      boldMarkdownHeaders(
        `Automatically selected the only pending step: [1] ${pendingSteps[0].prompt.split('\n')[0]}...`
      )
    );
  } else if (selectSteps === 'all') {
    log(`Selected all pending steps`);
    selectedPendingSteps = pendingSteps;
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
      globs: [],
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
    `## Overall Task: ${activeTask.title}\n`,
    `Description: ${activeTask.description}`,
    'This tasks is composed of subtasks, listed below. Only implement the specific subtasks mentioned.',
  ];
  if (previous && completedSteps.length > 0) {
    promptParts.push('## Completed Subtasks in this Task:');
    completedSteps.forEach((step) => promptParts.push(`- [DONE] ${step.prompt.split('\n')[0]}...`));
  }
  promptParts.push('\n## Current Subtasks to Implement:\n');
  // Some models (Gemini Pro 2.5 especially) will infer what the next step is and do it as part of the current step, then get confused when we
  // start the next step and generate a bad diff when they try to make the changes again. This helps to prevent that.
  promptParts.push(
    `**Important**: When thinking about these subtasks, consider that some part of them may have already been completed by an overeager engineer implementing the previous step. If you look at a file and it seems like a change has already been done, that is ok; just move on and don't try to make the edit again.\n`
  );

  if (selectedPendingSteps.length > 1) {
    promptParts.push('The current subtasks to implement are:');
    selectedPendingSteps.forEach((step, index) =>
      promptParts.push(`- [${index + 1}] ${step.prompt}`)
    );
  } else {
    promptParts.push('The current subtask to implement is:');
    promptParts.push(selectedPendingSteps[0].prompt);
  }

  if (!rmfilter) {
    // Get additional docs using findAdditionalDocs when rmfilter is false
    const { filteredMdcFiles } = await findAdditionalDocs(gitRoot, new Set(files), {
      'no-autodocs': false,
      docsPaths: config.paths?.docs || [],
    });

    // Add relevant files section
    promptParts.push(
      '## Relevant Files\n\nThese are relevant files for the next subtasks. If you think additional files are relevant, you can update them as well.'
    );

    // Add all files
    const filePrefix = options.filePathPrefix || '';
    files.forEach((file) => promptParts.push(`- ${filePrefix}${path.relative(gitRoot, file)}`));

    // Add MDC files with their descriptions if available
    if (filteredMdcFiles.length > 0) {
      promptParts.push('\n## Additional Documentation\n');
      for (const mdcFile of filteredMdcFiles) {
        const relativePath = path.relative(gitRoot, mdcFile.filePath);
        if (mdcFile.data?.description) {
          promptParts.push(`- ${filePrefix}${relativePath}: ${mdcFile.data.description}`);
        } else {
          promptParts.push(`- ${filePrefix}${relativePath}`);
        }
      }
    }
  }

  let llmPrompt = promptParts.join('\n');

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
    if (model) {
      baseRmfilterArgs.push('--model', model);
    }

    // Convert the potentially updated 'files' list (task + autofound) to relative paths
    const relativeFiles = files.map((f) => path.relative(gitRoot, f));

    // Check for examples in task, step prompts, and autoexamples from config
    let examples: string[] = [];
    if (activeTask.examples) {
      examples.push(...activeTask.examples);
    }
    for (const step of selectedPendingSteps) {
      if (step.examples) {
        examples.push(...step.examples);
      }
    }

    // Check for autoexamples in config
    if (config.autoexamples) {
      const promptText = selectedPendingSteps.map((step) => step.prompt).join('\n');
      for (const autoexample of config.autoexamples) {
        if (typeof autoexample === 'string') {
          if (promptText.includes(autoexample)) {
            examples.push(autoexample);
          }
        } else {
          if (promptText.includes(autoexample.find)) {
            examples.push(autoexample.example);
          }
        }
      }
    }

    examples = Array.from(new Set(examples));

    // Add example arguments if any examples are found
    const exampleArgs =
      examples.length > 0
        ? ['--', '.', ...examples.flatMap((example) => ['--example', example])]
        : [];

    if (performImportAnalysis) {
      // If import analysis is needed, construct the import command block
      const relativeCandidateFiles = candidateFilesForImports.map((f) => path.relative(gitRoot, f));
      const importCommandBlockArgs = ['--', ...relativeCandidateFiles];
      if (withAllImports) {
        importCommandBlockArgs.push('--with-all-imports');
      } else if (withImports) {
        importCommandBlockArgs.push('--with-imports');
      }

      if (withImporters) {
        importCommandBlockArgs.push('--with-importers');
      }

      // Pass base args, files (task+autofound), import block, example args, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...relativeFiles,
        ...importCommandBlockArgs,
        ...exampleArgs,
        ...(initialRmfilterArgs.length > 0 ? ['--', ...initialRmfilterArgs] : []),
      ];
    } else {
      // Pass base args, files (task+autofound), example args, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...relativeFiles,
        ...exampleArgs,
        ...(initialRmfilterArgs.length > 0 ? ['--', ...initialRmfilterArgs] : []),
      ];
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
  currentTask?: { taskIndex: number; stepIndex: number },
  baseDir?: string
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

    log(
      chalk.bold(
        `Marked ${nowDoneSteps.length} ${nowDoneSteps.length === 1 ? 'step' : 'steps'} done\n`
      )
    );
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
        output.push(
          boldMarkdownHeaders(`\n## Step ${task.steps.indexOf(step) + 1}\n\n${step.prompt}`)
        );
      }
    } else {
      output.push(`\n${task.steps[pending.stepIndex].prompt}`);
    }
  }

  // 5. Update metadata fields
  const gitRoot = await getGitRoot(baseDir);

  // Always update the updatedAt timestamp
  planData.updatedAt = new Date().toISOString();

  // Update changedFiles by comparing against baseBranch (or main/master if not set)
  try {
    const changedFiles = await getChangedFiles(gitRoot, planData.baseBranch);
    if (changedFiles.length > 0) {
      planData.changedFiles = changedFiles;
    }
  } catch (err) {
    // Log but don't fail if we can't get changed files
    warn(`Failed to get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if plan is now complete
  const stillPending = findPendingTask(planData);
  const planComplete = !stillPending;

  // If plan is complete, update status to 'done'
  if (planComplete) {
    planData.status = 'done';
  }

  // 6. Write updated plan back
  const newPlanText = yaml.stringify(planData);
  await Bun.write(planFile, newPlanText);

  // 7. Optionally commit
  const message = output.join('\n');
  log(boldMarkdownHeaders(message));
  if (options.commit) {
    log('');
    await commitAll(message, baseDir);
  }

  // 8. Return result
  return { planComplete, message };
}

/**
 * Executes a single post-apply command as defined in the configuration.
 * @param commandConfig The configuration object for the command.
 * @param overrideGitRoot Optional parameter to override the Git root directory.
 * @returns A promise resolving to `true` if the command succeeded or if failure was allowed,
 *          and `false` if the command failed and failure was not allowed.
 */
export async function executePostApplyCommand(
  commandConfig: PostApplyCommand,
  overrideGitRoot?: string
): Promise<boolean> {
  let effectiveGitRoot: string;
  try {
    if (overrideGitRoot) {
      effectiveGitRoot = overrideGitRoot;
    } else {
      effectiveGitRoot = await getGitRoot();
      if (!effectiveGitRoot) {
        // getGitRoot usually falls back to cwd, but handle defensively
        throw new Error('Could not determine Git repository root.');
      }
    }
  } catch (e) {
    error(
      `Error getting Git root for post-apply command: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  const cwd = commandConfig.workingDirectory
    ? path.resolve(effectiveGitRoot, commandConfig.workingDirectory)
    : effectiveGitRoot;

  const env = {
    ...process.env,
    ...(commandConfig.env || {}),
  };

  log(boldMarkdownHeaders(`\nRunning post-apply command: "${commandConfig.title}"...`));

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
      return true;
    } else {
      return false;
    }
  }

  log(`Post-apply command "${commandConfig.title}" completed successfully.`);
  return true;
}

/**
 * Prepares a phase by generating detailed steps and prompts for all tasks.
 * @param phaseYamlFile Path to the phase YAML file to prepare
 * @param config RmplanConfig instance
 * @param options Options including force flag and model override
 * @returns Promise that resolves when preparation is complete
 */
export async function preparePhase(
  phaseYamlFile: string,
  config: RmplanConfig,
  options: { force?: boolean; model?: string; rmfilterArgs?: string[] } = {}
): Promise<void> {
  try {
    // 1. Load the target phase YAML file
    const phaseContent = await Bun.file(phaseYamlFile).text();
    const parsedPhase = yaml.parse(phaseContent);
    const validationResult = phaseSchema.safeParse(parsedPhase);

    if (!validationResult.success) {
      throw new Error(
        `Failed to validate phase YAML: ${JSON.stringify(validationResult.error.issues, null, 2)}`
      );
    }

    const currentPhaseData = validationResult.data;

    // 2. Dependency Checking using readAllPlans
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
      const projectPlanDir = path.dirname(phaseYamlFile);
      const allPlans = await readAllPlans(projectPlanDir);

      for (const dependencyId of currentPhaseData.dependencies) {
        const dependencyPlan = allPlans.get(dependencyId);

        if (!dependencyPlan) {
          warn(`Warning: Could not find dependency ${dependencyId} in project directory`);
          if (!options.force) {
            throw new Error(
              'Cannot proceed without checking all dependencies. Use --force to override.'
            );
          }
          continue;
        }

        if (dependencyPlan.status !== 'done') {
          const msg = `Dependency ${dependencyId} is not complete (status: ${dependencyPlan.status}).`;
          warn(msg);

          if (!options.force) {
            throw new Error(
              'Cannot proceed without completed dependencies. Use --force to override.'
            );
          }

          warn('Proceeding despite incomplete dependencies due to --force flag.');
        }
      }
    }

    // 3. Determine projectPlanDir
    const projectPlanDir = path.dirname(phaseYamlFile);

    // 4. Call gatherPhaseGenerationContext
    let phaseGenCtx;
    try {
      phaseGenCtx = await gatherPhaseGenerationContext(
        phaseYamlFile,
        projectPlanDir,
        options.rmfilterArgs
      );
    } catch (err) {
      error('Failed to gather phase generation context:', err);

      // Save context gathering error
      try {
        const errorLogPath = phaseYamlFile.replace('.yaml', '.context_error.log');
        await Bun.write(
          errorLogPath,
          `Context gathering error at ${new Date().toISOString()}\n\nError: ${err as Error}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
        );
        error('Error log saved to:', errorLogPath);
      } catch (saveErr) {
        warn('Failed to save error log:', saveErr);
      }

      throw err;
    }

    // 5. Prepare rmfilter arguments for codebase context
    const rmfilterArgs = [...phaseGenCtx.rmfilterArgsFromPlan];

    // Add files from tasks if any are pre-populated
    for (const task of currentPhaseData.tasks) {
      if (task.files && task.files.length > 0) {
        rmfilterArgs.push(...task.files);
      }
    }

    // 6. Invoke rmfilter programmatically
    let codebaseContextXml: string;
    try {
      const gitRoot = (await getGitRoot()) || process.cwd();
      codebaseContextXml = await runRmfilterProgrammatically(
        [...rmfilterArgs, '--bare'],
        gitRoot,
        projectPlanDir
      );
    } catch (err) {
      error('Failed to execute rmfilter:', err);

      // Save rmfilter error
      try {
        const errorLogPath = phaseYamlFile.replace('.yml', '.rmfilter_error.log');
        await Bun.write(
          errorLogPath,
          `Rmfilter error at ${new Date().toISOString()}\n\nArgs: ${JSON.stringify(rmfilterArgs, null, 2)}\n\nError: ${err as Error}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
        );
        error('Error log saved to:', errorLogPath);
      } catch (saveErr) {
        warn('Failed to save error log:', saveErr);
      }

      throw err;
    }

    // 7. Construct LLM Prompt for Step Generation
    const phaseStepsPrompt = generatePhaseStepsPrompt(phaseGenCtx);
    const fullPrompt = `${phaseStepsPrompt}

<codebase_context>
${codebaseContextXml}
</codebase_context>`;

    // 8. Call LLM
    const modelId = options.model || config.models?.planning || DEFAULT_RUN_MODEL;
    const model = createModel(modelId);

    log('Generating detailed steps for phase using model:', modelId);

    const { text } = await generateText({
      model,
      prompt: fullPrompt,
      temperature: 0.2,
    });

    // 9. Parse LLM Output
    let parsedTasks;
    try {
      // Extract YAML from the response (LLM might include markdown formatting)
      const yamlContent = findYamlStart(text);
      const parsed = fixYaml(yamlContent);

      // Validate that we got a tasks array
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('LLM output does not contain a valid tasks array');
      }

      parsedTasks = parsed.tasks;
    } catch (err) {
      // Save raw LLM output for debugging
      const errorFilePath = phaseYamlFile.replace('.yaml', '.llm_error.txt');
      const partialErrorPath = phaseYamlFile.replace('.yaml', '.partial_error.yaml');

      try {
        await Bun.write(errorFilePath, text);
        error('Failed to parse LLM output. Raw output saved to:', errorFilePath);

        // Save the current phase YAML state before any modifications
        const currentYaml = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
${yaml.stringify(currentPhaseData)}`;
        await Bun.write(partialErrorPath, currentYaml);
        error('Current phase state saved to:', partialErrorPath);
      } catch (saveErr) {
        error('Failed to save error files:', saveErr);
      }

      error('Parse error:', err);
      error('Please manually correct the LLM output or retry with a different model');
      throw err;
    }

    // 10. Update Phase YAML
    // Merge LLM-generated task details into currentPhaseData.tasks
    for (let i = 0; i < currentPhaseData.tasks.length; i++) {
      const existingTask = currentPhaseData.tasks[i];
      const llmTask = parsedTasks[i];

      if (!llmTask) {
        warn(`Warning: LLM did not generate details for task ${i + 1}: ${existingTask.title}`);
        continue;
      }

      // Update task with LLM-generated details
      existingTask.description = llmTask.description || existingTask.description;
      existingTask.files = llmTask.files || [];
      existingTask.steps = llmTask.steps || [];
    }

    // Update timestamps
    const now = new Date().toISOString();
    currentPhaseData.promptsGeneratedAt = now;
    currentPhaseData.updatedAt = now;

    // 11. Write the updated phase YAML back to file
    const updatedYaml = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
${yaml.stringify(currentPhaseData)}`;

    await Bun.write(phaseYamlFile, updatedYaml);

    // 12. Log success
    log(chalk.green('✓ Successfully generated detailed steps for phase'));
    log(`Updated phase file: ${phaseYamlFile}`);
  } catch (err) {
    error('Failed to generate phase details:', err);
    throw err;
  }
}

/**
 * Gathers all necessary context for generating detailed implementation steps for a phase.
 * @param phaseFilePath Path to the phase YAML file to generate steps for
 * @param projectPlanDir Directory containing all phase YAML files
 * @returns Context object containing all information needed for phase step generation
 */
export async function gatherPhaseGenerationContext(
  phaseFilePath: string,
  projectPlanDir: string,
  rmfilterArgs?: string[]
): Promise<PhaseGenerationContext> {
  try {
    // 1. Load and validate the target phase YAML file
    const phaseContent = await Bun.file(phaseFilePath).text();
    const parsedPhase = yaml.parse(phaseContent);
    const validationResult = phaseSchema.safeParse(parsedPhase);

    if (!validationResult.success) {
      throw new Error(
        `Failed to validate phase YAML at ${phaseFilePath}: ${JSON.stringify(validationResult.error.issues, null, 2)}`
      );
    }

    const currentPhaseData = validationResult.data;

    // 2. Determine the overall project plan's goal and details
    let overallProjectGoal = '';
    let overallProjectDetails = '';
    let overallProjectTitle = '';

    // Check if the phase has project-level fields
    if (currentPhaseData.project) {
      overallProjectGoal = currentPhaseData.project.goal;
      overallProjectDetails = currentPhaseData.project.details;
      overallProjectTitle = currentPhaseData.project.title;
    }

    // 3. Initialize arrays for previous phases info and changed files
    const previousPhasesInfo: Array<{
      id: string;
      title: string;
      goal: string;
      description: string;
    }> = [];
    const changedFilesFromDependencies: string[] = [];

    // 4. Process each dependency
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
      for (const dependencyId of currentPhaseData.dependencies) {
        const dependencyPath = path.join(projectPlanDir, `${dependencyId}.yaml`);

        try {
          const dependencyContent = await Bun.file(dependencyPath).text();
          const parsedDependency = yaml.parse(dependencyContent);
          const validatedDependency = phaseSchema.safeParse(parsedDependency);

          if (!validatedDependency.success) {
            throw new Error(
              `Failed to validate dependency YAML at ${dependencyPath}: ${JSON.stringify(validatedDependency.error.issues, null, 2)}`
            );
          }

          const dependencyData = validatedDependency.data;

          // Check if dependency is done
          if (dependencyData.status !== 'done') {
            throw new Error(
              `Dependency ${dependencyId} is not completed (status: ${dependencyData.status}). All dependencies must be completed before generating phase steps.`
            );
          }

          // Extract title from details or use ID as fallback
          const title = dependencyData.details.split('\n')[0] || `Phase ${dependencyId}`;

          previousPhasesInfo.push({
            id: dependencyData.id || dependencyId,
            title: title,
            goal: dependencyData.goal,
            description: dependencyData.details,
          });

          // Add changed files from this dependency
          if (dependencyData.changedFiles && dependencyData.changedFiles.length > 0) {
            changedFilesFromDependencies.push(...dependencyData.changedFiles);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('ENOENT')) {
            throw new Error(`Dependency phase file not found: ${dependencyPath}`);
          }
          throw e;
        }
      }
    }

    // Deduplicate changed files
    const uniqueChangedFiles = Array.from(new Set(changedFilesFromDependencies));

    // 5. Build and return the context object
    const context: PhaseGenerationContext = {
      overallProjectGoal,
      overallProjectDetails,
      overallProjectTitle: overallProjectTitle || undefined,
      currentPhaseGoal: currentPhaseData.goal,
      currentPhaseDetails: currentPhaseData.details,
      currentPhaseTasks: currentPhaseData.tasks.map((task) => ({
        title: task.title,
        description: task.description,
      })),
      previousPhasesInfo,
      changedFilesFromDependencies: uniqueChangedFiles,
      rmfilterArgsFromPlan: [...(currentPhaseData.rmfilter || []), ...(rmfilterArgs || [])],
    };

    return context;
  } catch (e) {
    if (e instanceof Error) {
      error(`Error gathering phase generation context: ${e.message}`);
    } else {
      error(`Error gathering phase generation context: ${String(e)}`);
    }
    throw e;
  }
}
