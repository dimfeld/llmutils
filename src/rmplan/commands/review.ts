// Command handler for 'rmplan review'
// Analyzes code changes against plan requirements using the reviewer agent

import { $ } from 'bun';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import { readPlanFile, resolvePlanFile, readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getParentChain, getCompletedChildren } from '../utils/hierarchy.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';

export async function handleReviewCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Resolve the plan file (support both file paths and plan IDs)
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  // Load the plan details
  const planData = await readPlanFile(resolvedPlanFile);

  // Validate plan exists and has content
  if (!planData) {
    throw new Error(`Could not load plan from: ${resolvedPlanFile}`);
  }

  // Validate required plan fields
  if (!planData.goal) {
    throw new Error(`Plan file is missing required 'goal' field: ${resolvedPlanFile}`);
  }

  if (!planData.tasks || !Array.isArray(planData.tasks) || planData.tasks.length === 0) {
    throw new Error(`Plan file must have at least one task: ${resolvedPlanFile}`);
  }

  // Validate task structure
  for (const [index, task] of planData.tasks.entries()) {
    if (!task.title) {
      throw new Error(
        `Task ${index + 1} is missing required 'title' field in plan: ${resolvedPlanFile}`
      );
    }
    if (!task.description) {
      throw new Error(
        `Task ${index + 1} is missing required 'description' field in plan: ${resolvedPlanFile}`
      );
    }
  }

  log(chalk.green(`Reviewing plan: ${planData.id} - ${planData.title}`));

  // Load all plans for hierarchy traversal
  const gitRoot = await getGitRoot();
  const plansConfig = globalOpts.config || gitRoot;

  let parentChain: PlanWithFilename[] = [];
  let completedChildren: PlanWithFilename[] = [];

  try {
    const { plans: allPlans } = await readAllPlans(plansConfig);

    // Add filename to the current plan for hierarchy compatibility
    const planWithFilename: PlanWithFilename = {
      ...planData,
      filename: resolvedPlanFile,
    };

    // Use hierarchy utilities to get parent chain
    if (planData.id) {
      try {
        parentChain = getParentChain(planWithFilename, allPlans);

        if (parentChain.length > 0) {
          log(
            chalk.cyan(`Parent plan context loaded: ${parentChain[0].id} - ${parentChain[0].title}`)
          );
          if (parentChain.length > 1) {
            log(chalk.cyan(`Found ${parentChain.length} levels of parent plans`));
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.yellow(`Warning: Could not load parent chain: ${errorMessage}`));
        parentChain = [];
      }

      // Get completed children if this plan has any
      try {
        completedChildren = getCompletedChildren(planData.id, allPlans);

        if (completedChildren.length > 0) {
          log(chalk.cyan(`Found ${completedChildren.length} completed child plans`));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.yellow(`Warning: Could not load completed children: ${errorMessage}`));
        completedChildren = [];
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(
      chalk.yellow(
        `Warning: Could not read plan hierarchy: ${errorMessage}. Continuing with basic review.`
      )
    );
  }

  // Generate diff against trunk branch
  const diffResult = await generateDiffForReview(gitRoot);

  if (!diffResult.hasChanges) {
    log(chalk.yellow('No changes detected compared to trunk branch. Nothing to review.'));
    return;
  }

  log(chalk.cyan(`Found ${diffResult.changedFiles.length} changed files`));
  log(chalk.gray(`Comparing against: ${diffResult.baseBranch}`));

  // Load custom instructions
  let customInstructions = '';
  
  // First try CLI options (CLI takes precedence)
  if (options.instructions) {
    customInstructions = options.instructions;
    log(chalk.gray('Using inline custom instructions from CLI'));
  } else if (options.instructionsFile) {
    try {
      const instructionsPath = isAbsolute(options.instructionsFile) 
        ? options.instructionsFile 
        : join(gitRoot, options.instructionsFile);
      customInstructions = await readFile(instructionsPath, 'utf-8');
      log(chalk.gray(`Using custom instructions from CLI file: ${options.instructionsFile}`));
    } catch (err) {
      log(chalk.yellow(`Warning: Could not read instructions file from CLI: ${options.instructionsFile}. ${err}`));
    }
  } else if (config.review?.customInstructionsPath) {
    // Fall back to config file instructions
    try {
      const instructionsPath = isAbsolute(config.review.customInstructionsPath)
        ? config.review.customInstructionsPath
        : join(gitRoot, config.review.customInstructionsPath);
      customInstructions = await readFile(instructionsPath, 'utf-8');
      log(chalk.gray(`Using custom instructions from config: ${config.review.customInstructionsPath}`));
    } catch (err) {
      log(chalk.yellow(`Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${err}`));
    }
  }

  // Handle focus areas
  let focusAreas: string[] = [];
  if (options.focus) {
    // CLI focus areas override config
    focusAreas = options.focus.split(',').map((area: string) => area.trim()).filter(Boolean);
    log(chalk.gray(`Using focus areas from CLI: ${focusAreas.join(', ')}`));
  } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
    focusAreas = config.review.focusAreas;
    log(chalk.gray(`Using focus areas from config: ${focusAreas.join(', ')}`));
  }

  // Add focus areas to custom instructions if provided
  if (focusAreas.length > 0) {
    const focusInstruction = `Focus on: ${focusAreas.join(', ')}`;
    customInstructions = customInstructions 
      ? `${customInstructions}\n\n${focusInstruction}`
      : focusInstruction;
  }

  // Build the review prompt
  const reviewPrompt = buildReviewPrompt(planData, diffResult, parentChain, completedChildren, customInstructions);

  // Set up executor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: gitRoot,
    model: options.model,
    interactive: false, // Review mode doesn't need interactivity
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // Execute the review
  if (options.dryRun) {
    log(chalk.cyan('\n## Dry Run - Generated Review Prompt\n'));
    log(reviewPrompt);
    log('\n--dry-run mode: Would execute the above prompt');
    return;
  }

  log(chalk.cyan('\n## Executing Code Review\n'));

  try {
    await executor.execute(reviewPrompt, {
      planId: planData.id?.toString() ?? 'unknown',
      planTitle: planData.title ?? 'Untitled Plan',
      planFilePath: resolvedPlanFile,
    });

    log(chalk.green('\nCode review completed successfully!'));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Review execution failed: ${errorMessage}`);
  }
}

interface DiffResult {
  hasChanges: boolean;
  changedFiles: string[];
  baseBranch: string;
  diffContent: string;
}

// Maximum diff size to prevent memory issues (10MB)
const MAX_DIFF_SIZE = 10 * 1024 * 1024;

export function sanitizeBranchName(branch: string): string {
  // Only allow alphanumeric characters, hyphens, underscores, forward slashes, and dots
  // This is a conservative approach for git/jj branch names
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  // Additional security check: prevent path traversal attempts
  if (branch.includes('..') || branch.startsWith('/') || branch.includes('\\')) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  return branch;
}

export async function generateDiffForReview(gitRoot: string): Promise<DiffResult> {
  const baseBranch = await getTrunkBranch(gitRoot);
  if (!baseBranch) {
    throw new Error('Could not determine trunk branch for comparison');
  }

  // Sanitize branch name to prevent command injection
  const safeBranch = sanitizeBranchName(baseBranch);
  const usingJj = await getUsingJj();

  let changedFiles: string[] = [];
  let diffContent = '';

  if (usingJj) {
    // Use jj commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`jj diff --from ${safeBranch} --summary`.cwd(gitRoot).nothrow();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('D')) // Filter out deleted files and empty lines
          .map((line) => {
            // Handle renames (R old_file new_file) - get the new file name
            if (line.startsWith('R ')) {
              const parts = line.split(' ');
              return parts.length >= 3 ? parts[2] : null;
            }
            // Handle additions/modifications (A/M file) - get the file name
            if (line.length >= 2 && (line.startsWith('A ') || line.startsWith('M '))) {
              return line.slice(2);
            }
            // Unknown format, skip it
            return null;
          })
          .filter((filename): filename is string => filename !== null);
      } else {
        throw new Error(
          `jj diff --summary command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
        );
      }

      // Get full diff content
      const diffResult = await $`jj diff --from ${safeBranch}`.cwd(gitRoot).nothrow().quiet();
      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files or splitting the changes.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(
          `jj diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate jj diff: ${errorMessage}`);
    }
  } else {
    // Use git commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`git diff --name-only ${safeBranch}`
        .cwd(gitRoot)
        .nothrow()
        .quiet();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => !!line);
      } else {
        throw new Error(
          `git diff --name-only command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
        );
      }

      // Get full diff content
      const diffResult = await $`git diff ${safeBranch}`.cwd(gitRoot).nothrow();
      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files or splitting the changes.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(
          `git diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate git diff: ${errorMessage}`);
    }
  }

  return {
    hasChanges: changedFiles.length > 0,
    changedFiles,
    baseBranch: baseBranch, // Return original for display purposes
    diffContent,
  };
}

export function buildReviewPrompt(
  planData: PlanSchema,
  diffResult: DiffResult,
  parentChain: PlanWithFilename[] = [],
  completedChildren: PlanWithFilename[] = [],
  customInstructions?: string
): string {
  // Build parent plan context section if available
  const parentContext: string[] = [];
  if (parentChain.length > 0) {
    parentContext.push(`# Parent Plan Context`, ``);

    // Include all parents in the chain, starting with immediate parent
    parentChain.forEach((parent, index) => {
      const level = index === 0 ? 'Parent' : `Grandparent (Level ${index + 1})`;
      parentContext.push(
        `**${level} Plan ID:** ${parent.id}`,
        `**${level} Title:** ${parent.title}`,
        `**${level} Goal:** ${parent.goal}`,
        ``
      );

      if (parent.details) {
        parentContext.push(`**${level} Details:** ${parent.details}`, ``);
      }

      if (index < parentChain.length - 1) {
        parentContext.push(`---`, ``);
      }
    });

    parentContext.push(
      `*Note: This review is for a child plan implementing part of the parent plan${parentChain.length > 1 ? 's' : ''} above.*`,
      ``,
      ``
    );
  }

  // Build completed children context section if available
  const childrenContext: string[] = [];
  if (completedChildren.length > 0) {
    childrenContext.push(
      `# Completed Child Plans`,
      ``,
      `The following child plans have been completed as part of this parent plan:`,
      ``
    );

    completedChildren.forEach((child) => {
      childrenContext.push(
        `**Child Plan ID:** ${child.id}`,
        `**Child Title:** ${child.title}`,
        `**Child Goal:** ${child.goal}`,
        ``
      );

      if (child.details) {
        childrenContext.push(`**Child Details:** ${child.details}`, ``);
      }
    });

    childrenContext.push(
      `*Note: When reviewing this parent plan, consider how these completed children contribute to the overall goals.*`,
      ``,
      ``
    );
  }

  // Build plan context section
  const planContext = [
    `# Plan Context`,
    ``,
    `**Plan ID:** ${planData.id}`,
    `**Title:** ${planData.title}`,
    `**Goal:** ${planData.goal}`,
    ``,
  ];

  if (planData.details) {
    planContext.push(`**Details:**`, planData.details, ``);
  }

  if (planData.tasks && planData.tasks.length > 0) {
    planContext.push(`**Tasks:**`);
    planData.tasks.forEach((task, index) => {
      planContext.push(`${index + 1}. **${task.title}**`);
      if (task.description) {
        planContext.push(`   ${task.description}`);
      }
      if (task.steps && task.steps.length > 0) {
        planContext.push(`   Steps:`);
        task.steps.forEach((step, stepIndex) => {
          const status = step.done ? '✓' : '○';
          planContext.push(`   ${status} ${stepIndex + 1}. ${step.prompt.split('\n')[0]}`);
        });
      }
      planContext.push(``);
    });
  }

  // Build changed files section
  const changedFilesSection = [
    `# Code Changes to Review`,
    ``,
    `**Base Branch:** ${diffResult.baseBranch}`,
    `**Changed Files (${diffResult.changedFiles.length}):**`,
  ];

  diffResult.changedFiles.forEach((file) => {
    changedFilesSection.push(`- ${file}`);
  });

  changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');

  // Combine everything into the final prompt
  const contextContent = [
    ...parentContext,
    ...childrenContext,
    ...planContext,
    ``,
    ...changedFilesSection,
    ``,
    `# Review Instructions`,
    ``,
    `Please review the code changes above in the context of the plan requirements. Focus on:`,
    `1. **Compliance with Plan Requirements:** Do the changes fulfill the goals and tasks outlined in the plan?`,
    `2. **Code Quality:** Look for bugs, logic errors, security issues, and performance problems`,
    `3. **Implementation Completeness:** Are all required features implemented according to the plan?`,
    `4. **Error Handling:** Are edge cases and error conditions properly handled?`,
    `5. **Testing:** Are the changes adequately tested?`,
    ``,
  ].join('\n');

  // Use the reviewer agent template with our context and custom instructions
  const reviewerPromptWithContext = getReviewerPrompt(contextContent, customInstructions || '');

  return reviewerPromptWithContext.prompt;
}
