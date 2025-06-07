/**
 * @fileoverview Core action implementations for rmplan operations. This module contains
 * the business logic for plan management including step preparation, task completion,
 * phase generation, and post-apply command execution.
 *
 * This module has been refactored to leverage the new common utilities architecture:
 * - Uses src/common/git.ts for repository operations and branch detection
 * - Uses src/common/process.ts for commit operations and process spawning
 * - Uses src/common/clipboard.ts for clipboard operations
 * - Integrates with dependency graph utilities for import analysis
 * - Leverages rmfilter programmatic interface for context preparation
 *
 * Key responsibilities:
 * - Preparing execution prompts for plan steps with context gathering
 * - Managing plan lifecycle (marking steps done, updating metadata)
 * - Generating detailed phase implementations from high-level descriptions
 * - Executing post-apply commands with proper error handling
 * - Coordinating with LLM execution through the executor system
 * - Handling workspace isolation and file path management
 *
 * The module supports both interactive and automated workflows, with extensive
 * integration capabilities for file discovery, import analysis, and context preparation.
 */

import { select } from '@inquirer/prompts';
import { generateText } from 'ai';
import chalk from 'chalk';
import os from 'node:os';
import path from 'path';
import yaml from 'yaml';
import { Resolver } from '../dependency_graph/resolve.js';
import { ImportWalker } from '../dependency_graph/walk_imports.js';
import { boldMarkdownHeaders, error, log, warn, writeStderr, writeStdout } from '../logging.js';
import {
  findAdditionalDocs,
  getChangedFiles,
  type GetChangedFilesOptions,
} from '../rmfilter/additional_docs.js';
import { extractFileReferencesFromInstructions } from '../rmfilter/instructions.js';
import { commitAll, quiet } from '../common/process.js';
import { getGitRoot } from '../common/git.js';
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
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from './llm_utils/run_and_apply.js';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.js';
import { readAllPlans, readPlanFile, writePlanFile, type PlanSummary } from './plans.js';
import * as clipboard from '../common/clipboard.js';
import { sshAwarePasteAction } from '../common/ssh_detection.js';
import { waitForEnter } from '../common/terminal.js';

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

/**
 * Finds the next pending (not completed) task and step in a plan.
 * This function performs a linear search through tasks and steps to find
 * the first step that has not been marked as done.
 *
 * @param plan - The plan schema to search through
 * @returns PendingTaskResult with task/step indices and objects, or null if all steps are done
 */
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

/**
 * Prepares the next step(s) from a plan for LLM execution by gathering context and building prompts.
 * This function is a core part of the refactored architecture, integrating multiple common utilities:
 *
 * - Uses src/common/git.ts for repository root detection and operations
 * - Leverages dependency graph analysis for import resolution when requested
 * - Integrates with rmfilter programmatically for context preparation
 * - Uses rmfind for automatic file discovery based on plan content
 * - Handles both single-step and multi-step execution scenarios
 *
 * The function supports extensive customization through options including import analysis,
 * automatic file discovery, and different context preparation strategies.
 *
 * @param config - RmplanConfig with user preferences and settings
 * @param planFile - Path or ID of the plan file to process
 * @param options - Options controlling import analysis, file discovery, and context preparation
 * @param baseDir - Optional base directory override for file operations
 * @returns Promise resolving to execution prompt and metadata for the selected steps
 * @throws {Error} When plan cannot be loaded, no pending steps exist, or context preparation fails
 */
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
  const planData = await readPlanFile(planFile);
  const result = findPendingTask(planData);
  if (!result) {
    throw new Error('No pending steps found in the plan.');
  }
  const activeTask = result.task;
  const performImportAnalysis = withImports || withAllImports || withImporters;

  // Strip parenthetical comments from filenames (e.g., "file.ts (New File)" -> "file.ts")
  const cleanFiles =
    activeTask.files?.map((file) => file.replace(/\s*\([^)]*\)\s*$/, '').trim()) ?? [];

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

  const promptParts: string[] = [];

  if (planData.project?.goal) {
    promptParts.push(
      `# Project Goal: ${planData.project.goal}\n`,
      'These instructions define a particular step of a feature implementation for this project'
    );

    if (planData.project.details) {
      promptParts.push(`## Project Details:\n\n${planData.project.details}\n`);
    }

    promptParts.push(
      `# Current Phase Goal: ${planData.goal}\n\n## Phase Details:\n\n${planData.details}\n`
    );
  } else {
    // 5. Build the LLM prompt
    promptParts.push(
      `# Project Goal: ${planData.goal}\n\n## Project Details:\n\n${planData.details}\n`
    );
  }

  promptParts.push(
    `## Overall Task: ${activeTask.title}\n`,
    `Description: ${activeTask.description}`,
    'This tasks is composed of subtasks, listed below. Only implement the specific subtasks mentioned.'
  );
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
    // Collect docs from phase and task only (config paths are handled elsewhere)
    const docsSet = new Set<string>();

    // Add docs from the current phase
    if (planData.docs) {
      planData.docs.forEach((doc: string) => docsSet.add(doc));
    }

    // Add docs from the active task
    if (activeTask.docs) {
      activeTask.docs.forEach((doc: string) => docsSet.add(doc));
    }

    // Get additional docs using findAdditionalDocs when rmfilter is false
    const { filteredMdcFiles } = await findAdditionalDocs(gitRoot, new Set(files), {
      'no-autodocs': false,
    });

    // Add relevant files section
    promptParts.push(
      '## Relevant Files\n\nThese are relevant files for the next subtasks. If you think additional files are relevant, you can update them as well.'
    );

    // Add all files
    const filePrefix = options.filePathPrefix || '';
    files.forEach((file) => promptParts.push(`- ${filePrefix}${path.relative(gitRoot, file)}`));

    // Add MDC files with their descriptions if available
    if (filteredMdcFiles.length > 0 || docsSet.size > 0) {
      promptParts.push('\n## Additional Documentation\n');
      for (const mdcFile of filteredMdcFiles) {
        const relativePath = path.relative(gitRoot, mdcFile.filePath);
        if (mdcFile.data?.description) {
          promptParts.push(`- ${filePrefix}${relativePath}: ${mdcFile.data.description}`);
        } else {
          promptParts.push(`- ${filePrefix}${relativePath}`);
        }
      }

      for (const doc of docsSet) {
        promptParts.push(`- ${filePrefix}${doc}`);
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

    // Collect docs from phase and task only (config paths are handled elsewhere)
    const docsSet = new Set<string>();

    // Add docs from the current phase
    if (planData.docs) {
      planData.docs.forEach((doc: string) => docsSet.add(doc));
    }

    // Add docs from the active task
    if (activeTask.docs) {
      activeTask.docs.forEach((doc: string) => docsSet.add(doc));
    }

    // Convert to array and create --docs arguments
    const docs = Array.from(docsSet);
    const docsArgs = docs.flatMap((doc) => ['--docs', doc]);

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

      // Pass base args, docs, files (task+autofound), import block, example args, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...docsArgs,
        ...relativeFiles,
        ...importCommandBlockArgs,
        ...exampleArgs,
        ...(initialRmfilterArgs.length > 0 ? ['--', ...initialRmfilterArgs] : []),
      ];
    } else {
      // Pass base args, docs, files (task+autofound), example args, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...docsArgs,
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

/**
 * Marks one or more steps as completed in a plan file and updates plan metadata.
 * This function integrates with the refactored common utilities for Git operations
 * and uses src/common/process.ts for commit operations when requested.
 *
 * The function handles:
 * - Updating step completion status in the plan file
 * - Refreshing plan metadata including timestamps and changed files
 * - Determining if the entire plan is now complete
 * - Optionally committing changes using the appropriate VCS (Git/Jujutsu)
 * - Providing formatted output for user feedback
 *
 * @param planFile - Path or ID of the plan file to update
 * @param options - Configuration for which steps to mark and whether to commit
 * @param currentTask - Optional specific task/step indices to mark (overrides automatic detection)
 * @param baseDir - Optional base directory for Git operations
 * @param config - Optional RmplanConfig for path configuration
 * @returns Promise resolving to completion status and user-facing message
 * @throws {Error} When plan file cannot be loaded/written or Git operations fail
 */
export async function markStepDone(
  planFile: string,
  options: { task?: boolean; steps?: number; commit?: boolean },
  currentTask?: { taskIndex: number; stepIndex: number },
  baseDir?: string,
  config?: RmplanConfig
): Promise<{ planComplete: boolean; message: string }> {
  // 1. Load and parse the plan file
  let planData = await readPlanFile(planFile);

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
    // Build exclude paths from config
    const excludePaths: string[] = [];
    if (config?.paths?.tasks) {
      // Resolve tasks path relative to git root if it's relative
      const tasksPath = path.isAbsolute(config.paths.tasks)
        ? config.paths.tasks
        : path.join(gitRoot, config.paths.tasks);

      // Make it relative to git root for comparison
      excludePaths.push(path.relative(gitRoot, tasksPath));
    }

    const options: GetChangedFilesOptions = {
      baseBranch: planData.baseBranch,
      excludePaths,
    };

    const changedFiles = await getChangedFiles(gitRoot, options);
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
  await writePlanFile(planFile, planData);

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
 * This function integrates with the refactored common utilities, using src/common/git.ts
 * for repository root detection and src/common/process.ts patterns for command execution.
 *
 * The function handles:
 * - Working directory resolution relative to Git root
 * - Environment variable configuration
 * - Output buffering and conditional display based on success/failure
 * - Cross-platform shell command execution (Windows vs Unix)
 * - Graceful error handling with optional failure tolerance
 *
 * @param commandConfig - The configuration object for the command to execute
 * @param overrideGitRoot - Optional override for Git root directory detection
 * @returns Promise resolving to true if command succeeded or failure was allowed, false otherwise
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
 * Prepares a phase by generating detailed implementation steps and prompts for all tasks.
 * This function represents a key integration point in the refactored architecture, combining:
 *
 * - Plan file management through the centralized plans.js utilities
 * - Dependency analysis and validation across phase relationships
 * - Context gathering using rmfilter programmatic interface
 * - LLM integration through the executor system or direct API calls
 * - Git operations through src/common/git.ts for repository management
 * - Clipboard operations through src/common/clipboard.ts for workflow management
 *
 * The function orchestrates the complex workflow of converting high-level phase descriptions
 * into detailed, executable implementation steps by gathering context about previous phases,
 * changed files, and project structure.
 *
 * @param phaseYamlFile - Path to the phase YAML file to prepare with detailed steps
 * @param config - RmplanConfig instance with user preferences and model settings
 * @param options - Configuration options for forcing preparation, model selection, and execution mode
 * @returns Promise that resolves when phase preparation is complete
 * @throws {Error} When dependencies are incomplete, context gathering fails, or LLM execution errors
 */
export async function preparePhase(
  phaseYamlFile: string,
  config: RmplanConfig,
  options: { force?: boolean; model?: string; rmfilterArgs?: string[]; direct?: boolean } = {}
): Promise<void> {
  try {
    // Load the target phase YAML file
    const currentPhaseData = await readPlanFile(phaseYamlFile);
    const projectPlanDir = path.dirname(phaseYamlFile);
    const { plans: allPlans } = await readAllPlans(projectPlanDir);

    // Dependency Checking
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
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

    // Call gatherPhaseGenerationContext
    let phaseGenCtx = await gatherPhaseGenerationContext(
      phaseYamlFile,
      projectPlanDir,
      allPlans,
      options.rmfilterArgs
    );

    // Prepare rmfilter arguments for codebase context
    const rmfilterArgs = [...phaseGenCtx.rmfilterArgsFromPlan];

    // Add files from tasks if any are pre-populated
    for (const task of currentPhaseData.tasks) {
      if (task.files && task.files.length > 0) {
        rmfilterArgs.push(...task.files);
      }
    }

    // Collect docs from phase and tasks only (config paths are handled elsewhere)
    const docsSet = new Set<string>();

    // Add docs from the current phase
    if (currentPhaseData.docs) {
      currentPhaseData.docs.forEach((doc: string) => docsSet.add(doc));
    }

    // Add docs from tasks
    for (const task of currentPhaseData.tasks) {
      if (task.docs) {
        task.docs.forEach((doc: string) => docsSet.add(doc));
      }
    }

    // Convert to array and create --docs arguments
    const docs = Array.from(docsSet);
    const docsArgs = docs.flatMap((doc) => ['--docs', doc]);

    const phaseStepsPrompt = generatePhaseStepsPrompt(phaseGenCtx);

    // 6. Invoke rmfilter programmatically
    let prompt: string;
    try {
      const gitRoot = (await getGitRoot()) || process.cwd();
      prompt = await runRmfilterProgrammatically(
        [...rmfilterArgs, ...docsArgs, '--bare', '--instructions', phaseStepsPrompt],
        gitRoot,
        gitRoot
      );
    } catch (err) {
      error('Failed to execute rmfilter:', err);
      throw err;
    }

    // 7. Call LLM or use clipboard/paste mode
    let text: string;

    if (options.direct) {
      // Direct LLM call
      const modelId = options.model || config.models?.stepGeneration || DEFAULT_RUN_MODEL;
      const model = createModel(modelId);

      log('Generating detailed steps for phase using model:', modelId);

      const result = await runStreamingPrompt({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      });
      text = result.text;
    } else {
      // Clipboard/paste mode
      await clipboard.write(prompt);
      log(chalk.green('✓ Phase preparation prompt copied to clipboard'));
      log(
        chalk.bold(
          `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} with the detailed steps, or Ctrl+C to exit.`
        )
      );

      text = await waitForEnter(true);

      if (!text || !text.trim()) {
        throw new Error('No response was pasted.');
      }
    }

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

      try {
        await Bun.write(errorFilePath, text);
        error('Failed to parse LLM output. Raw output saved to:', errorFilePath);
      } catch (saveErr) {
        error('Failed to save error files:', saveErr);
      }

      error('Parse error:', err);
      error('Please manually correct the LLM output or retry with a different model');
      throw err;
    }

    // 10. Update Phase YAML
    if (currentPhaseData.tasks?.length) {
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
    } else {
      // If currentPhaseData.tasks is empty, assign parsedTasks directly
      currentPhaseData.tasks = parsedTasks;
    }

    // Update timestamps
    const now = new Date().toISOString();
    currentPhaseData.promptsGeneratedAt = now;
    currentPhaseData.updatedAt = now;

    // 11. Write the updated phase YAML back to file
    await writePlanFile(phaseYamlFile, currentPhaseData);

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
async function gatherPhaseGenerationContext(
  phaseFilePath: string,
  projectPlanDir: string,
  allPlans: Map<string | number, PlanSchema & { filename: string }>,
  rmfilterArgs?: string[]
): Promise<PhaseGenerationContext> {
  try {
    // 1. Load and validate the target phase YAML file
    const currentPhaseData = await readPlanFile(phaseFilePath);

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
      id: string | number;
      title: string;
      goal: string;
      description: string;
    }> = [];
    const changedFilesFromDependencies: string[] = [];

    // 4. Process each dependency
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
      // Read all plans in the directory to find dependencies by ID
      const { plans: allPlans } = await readAllPlans(projectPlanDir);

      for (const dependencyId of currentPhaseData.dependencies) {
        const dependencyPlan = allPlans.get(dependencyId);

        if (!dependencyPlan) {
          throw new Error(
            `Dependency phase with ID '${dependencyId}' not found in project directory`
          );
        }

        // Check if dependency is done
        if (dependencyPlan.status !== 'done') {
          throw new Error(
            `Dependency ${dependencyId} is not completed (status: ${dependencyPlan.status}). All dependencies must be completed before generating phase steps.`
          );
        }

        // Extract title from details or use ID as fallback
        const title = dependencyPlan.details.split('\n')[0] || `Phase ${dependencyId}`;

        previousPhasesInfo.push({
          id: dependencyPlan.id || dependencyId,
          title: title,
          goal: dependencyPlan.goal,
          description: dependencyPlan.details,
        });

        // Add changed files from this dependency
        if (dependencyPlan.changedFiles && dependencyPlan.changedFiles.length > 0) {
          changedFilesFromDependencies.push(...dependencyPlan.changedFiles);
        }
      }
    }

    // Deduplicate changed files
    const uniqueChangedFiles = Array.from(new Set(changedFilesFromDependencies));

    const changedFilesExist = (
      await Promise.all(
        uniqueChangedFiles.map(async (file) => {
          try {
            if (await Bun.file(file).exists()) {
              return file;
            }
            return false;
          } catch (err) {
            return false;
          }
        })
      )
    ).filter(Boolean) as string[];

    const rmfilterArgsFromPlan = [...(currentPhaseData.rmfilter || []), ...(rmfilterArgs || [])];

    if (changedFilesExist.length > 0) {
      rmfilterArgsFromPlan.push('--', ...changedFilesExist);
    }

    // 5. Build and return the context object
    const context: PhaseGenerationContext = {
      overallProjectGoal,
      overallProjectDetails,
      overallProjectTitle: overallProjectTitle || undefined,
      currentPhaseTitle: currentPhaseData.title,
      currentPhaseGoal: currentPhaseData.goal,
      currentPhaseDetails: currentPhaseData.details,
      currentPhaseTasks: currentPhaseData.tasks.map((task) => ({
        title: task.title,
        description: task.description,
      })),
      previousPhasesInfo,
      changedFilesFromDependencies: changedFilesExist,
      rmfilterArgsFromPlan,
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
