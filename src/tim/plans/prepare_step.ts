import path from 'path';
import { getGitRoot } from '../../common/git.js';
import { findAdditionalDocs } from '../../common/additional_docs.js';
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import { findSiblingPlans } from '../context_helpers.js';
import { readPlanFile } from '../plans.js';
import { findPendingTask } from './find_next.js';

export interface PrepareNextStepOptions {
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
  taskIndex: number;
}> {
  // 1. Load and parse the plan file
  const planData = await readPlanFile(planFile);
  const result = findPendingTask(planData);
  if (!result) {
    throw new Error('No pending tasks found in the plan.');
  }
  const activeTask = result.task;

  const gitRoot = await getGitRoot(baseDir);
  let files: string[] = [];

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

  // Get additional docs
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

  let llmPrompt = promptParts.join('\n');

  // Return result
  return {
    prompt: llmPrompt,
    taskIndex: result.taskIndex,
  };
}
