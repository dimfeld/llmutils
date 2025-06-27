import { select } from '@inquirer/prompts';
import os from 'node:os';
import path from 'path';
import { getGitRoot } from '../../common/git.js';
import { quiet } from '../../common/process.js';
import { Resolver } from '../../dependency_graph/resolve.js';
import { ImportWalker } from '../../dependency_graph/walk_imports.js';
import { boldMarkdownHeaders, log, warn } from '../../logging.js';
import { findAdditionalDocs } from '../../rmfilter/additional_docs.js';
import { extractFileReferencesFromInstructions } from '../../rmfilter/instructions.js';
import { findFilesCore, type RmfindOptions } from '../../rmfind/core.js';
import { Extractor } from '../../treesitter/extract.js';
import { resolveTasksDir, type RmplanConfig } from '../configSchema.js';
import { findSiblingPlans } from '../context_helpers.js';
import { readPlanFile } from '../plans.js';
import { findPendingTask } from './find_next.js';

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

  // Add current plan filename context
  const root = await getGitRoot();
  const currentPlanFilename = path.relative(root, planFile);
  promptParts.push(`## Current Plan File: ${currentPlanFilename}\n`);

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

  // Add sibling plan context if there's a parent
  if (planData.parent) {
    const tasksDir = await resolveTasksDir(config);
    const siblings = await findSiblingPlans(planData.id || 0, planData.parent, tasksDir);

    if (siblings.completed.length > 0 || siblings.pending.length > 0) {
      promptParts.push('\n## Related Plans (Same Parent)\n');
      promptParts.push(
        'These plans are part of the same parent plan and can provide additional context:\n'
      );

      if (siblings.completed.length > 0) {
        promptParts.push('### Completed Related Plans:');
        siblings.completed.forEach((sibling) => {
          promptParts.push(
            `- **${sibling.title}** (File: ${path.relative(root, sibling.filename)})`
          );
        });
      }

      if (siblings.pending.length > 0) {
        promptParts.push('\n### Pending Related Plans:');
        siblings.pending.forEach((sibling) => {
          promptParts.push(
            `- **${sibling.title}** (File: ${path.relative(root, sibling.filename)})`
          );
        });
      }
      promptParts.push('');
    }
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

  // Helper function to check if a string is a URL
  const isURL = (str: string): boolean => {
    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  };

  if (!rmfilter) {
    // Collect docs from phase and task only (config paths are handled elsewhere)
    const docsSet = new Set<string>();
    const docURLsSet = new Set<string>();

    // Add docs from the current phase
    if (planData.docs) {
      planData.docs.forEach((doc: string) => {
        if (isURL(doc)) {
          docURLsSet.add(doc);
        } else {
          docsSet.add(doc);
        }
      });
    }

    // Add docs from the active task
    if (activeTask.docs) {
      activeTask.docs.forEach((doc: string) => {
        if (isURL(doc)) {
          docURLsSet.add(doc);
        } else {
          docsSet.add(doc);
        }
      });
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
    if (filteredMdcFiles.length > 0 || docsSet.size > 0 || docURLsSet.size > 0) {
      promptParts.push('\n## Additional Documentation\n');

      // Add MDC files
      for (const mdcFile of filteredMdcFiles) {
        const relativePath = path.relative(gitRoot, mdcFile.filePath);
        if (mdcFile.data?.description) {
          promptParts.push(`- ${filePrefix}${relativePath}: ${mdcFile.data.description}`);
        } else {
          promptParts.push(`- ${filePrefix}${relativePath}`);
        }
      }

      // Add local doc files
      for (const doc of docsSet) {
        promptParts.push(`- ${filePrefix}${doc}`);
      }

      // Add doc URLs
      if (docURLsSet.size > 0) {
        promptParts.push('\n### Documentation URLs\n');
        for (const url of docURLsSet) {
          promptParts.push(`- ${url}`);
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
