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
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import { findSiblingPlans } from '../context_helpers.js';
import { readPlanFile } from '../plans.js';
import { findPendingTask } from './find_next.js';

export interface PrepareNextStepOptions {
  rmfilter?: boolean;
  withImports?: boolean;
  withAllImports?: boolean;
  withImporters?: boolean;
  rmfilterArgs?: string[];
  model?: string;
  autofind?: boolean;
  filePathPrefix?: string;
}

/**
 * Prepares the next task from a plan for LLM execution by gathering context and building prompts.
 * This function is a core part of the refactored architecture, integrating multiple common utilities:
 *
 * - Uses src/common/git.ts for repository root detection and operations
 * - Leverages dependency graph analysis for import resolution when requested
 * - Integrates with rmfilter programmatically for context preparation
 * - Uses rmfind for automatic file discovery based on plan content
 *
 * The function supports extensive customization through options including import analysis,
 * automatic file discovery, and different context preparation strategies.
 *
 * @param config - TimConfig with user preferences and settings
 * @param planFile - Path or ID of the plan file to process
 * @param options - Options controlling import analysis, file discovery, and context preparation
 * @param baseDir - Optional base directory override for file operations
 * @returns Promise resolving to execution prompt and metadata for the selected task
 * @throws {Error} When plan cannot be loaded, no pending tasks exist, or context preparation fails
 */
export async function prepareNextStep(
  config: TimConfig,
  planFile: string,
  options: PrepareNextStepOptions = {},
  baseDir?: string
): Promise<{
  prompt: string;
  promptFilePath: string | null;
  taskIndex: number;
  rmfilterArgs: string[] | undefined;
}> {
  const {
    rmfilter = false,
    withImports = false,
    withAllImports = false,
    withImporters = false,
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
    throw new Error('No pending tasks found in the plan.');
  }
  const activeTask = result.task;
  const performImportAnalysis = withImports || withAllImports || withImporters;

  const gitRoot = await getGitRoot(baseDir);
  let files: string[] = [];

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
        files = rmfindResult.files;
      }
    } catch (error) {
      warn(
        `[Autofind] Warning: Failed to find files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Perform import analysis if requested
  let candidateFilesForImports: string[] = [];
  if (performImportAnalysis) {
    const prompts = activeTask.description;
    const { files: filesFromPrompt } = await extractFileReferencesFromInstructions(
      gitRoot,
      prompts
    );

    if (filesFromPrompt.length > 0) {
      // If prompt has files, use them. Ensure they are absolute paths.
      candidateFilesForImports = filesFromPrompt.map((f) => path.resolve(gitRoot, f));
      if (!quiet) {
        log(`Using ${candidateFilesForImports.length} files found in prompt for import analysis.`);
      }
    } else {
      // Fallback to autofound files
      candidateFilesForImports = files.map((f) => path.resolve(gitRoot, f));
    }
    // Filter out any non-existent files
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

  const promptParts: string[] = [];

  // Add current plan filename context
  const root = await getGitRoot();
  const currentPlanFilename = path.relative(root, planFile);
  promptParts.push(`## Current Plan File: ${currentPlanFilename}\n`);

  const tasksDir = await resolveTasksDir(config);
  const { siblings, parent } = await findSiblingPlans(planData.id || 0, planData.parent, tasksDir);

  let projectInfo = planData.project ?? parent;
  if (projectInfo?.goal) {
    promptParts.push(
      `# Project Goal: ${projectInfo.goal}\n`,
      'These instructions define a particular step of a feature implementation for this project'
    );

    if (projectInfo.details) {
      promptParts.push(`## Project Details:\n\n${projectInfo.details}\n`);
    }

    promptParts.push(
      `# Current Phase Goal: ${planData.goal}\n\n## Phase Details:\n\n${planData.details}\n`
    );
  } else {
    promptParts.push(
      `# Project Goal: ${planData.goal}\n\n## Project Details:\n\n${planData.details}\n`
    );
  }

  // Add sibling plan context if there's a parent
  if (planData.parent) {
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

  promptParts.push(`## Task: ${activeTask.title}\n`, `Description: ${activeTask.description}`);

  if (!rmfilter) {
    // Get additional docs using findAdditionalDocs when rmfilter is false
    const { filteredMdcFiles } = await findAdditionalDocs(gitRoot, new Set(files), {
      'no-autodocs': false,
      docsPaths: config.paths?.docs,
      instructions: [activeTask.description],
    });

    // Add relevant files section
    promptParts.push(
      '\n## Relevant Files\n\nThese are relevant files for the task. If you think additional files are relevant, you can update them as well.'
    );

    // Add all files
    const filePrefix = options.filePathPrefix || '';
    files.forEach((file) => promptParts.push(`- ${filePrefix}${path.relative(gitRoot, file)}`));

    // Add MDC files with their descriptions if available
    if (filteredMdcFiles.length > 0) {
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
    }
  }

  let llmPrompt = promptParts.join('\n');

  // Handle rmfilter
  let promptFilePath: string | null = null;
  let finalRmfilterArgs: string[] | undefined;
  if (rmfilter) {
    promptFilePath = path.join(
      os.tmpdir(),
      `tim-next-prompt-${Date.now()}-${crypto.randomUUID()}.md`
    );
    await Bun.write(promptFilePath, llmPrompt);

    const baseRmfilterArgs = ['--gitroot', '--instructions', `@${promptFilePath}`];
    if (model) {
      baseRmfilterArgs.push('--model', model);
    }

    // Convert the potentially updated 'files' list to relative paths
    const relativeFiles = files.map((f) => path.relative(gitRoot, f));

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

      // Pass base args, files, import block, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...relativeFiles,
        ...importCommandBlockArgs,
        ...(initialRmfilterArgs.length > 0 ? ['--', ...initialRmfilterArgs] : []),
      ];
    } else {
      // Pass base args, files, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...relativeFiles,
        ...(initialRmfilterArgs.length > 0 ? ['--', ...initialRmfilterArgs] : []),
      ];
    }
  }

  // Return result
  return {
    prompt: llmPrompt,
    promptFilePath,
    taskIndex: result.taskIndex,
    rmfilterArgs: finalRmfilterArgs,
  };
}
