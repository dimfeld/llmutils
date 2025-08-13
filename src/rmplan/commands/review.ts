// Command handler for 'rmplan review'
// Analyzes code changes against plan requirements using the reviewer agent

import { $ } from 'bun';
import chalk from 'chalk';
import { getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

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

  log(chalk.green(`Reviewing plan: ${planData.id} - ${planData.title}`));

  // Generate diff against trunk branch
  const gitRoot = await getGitRoot();
  const diffResult = await generateDiffForReview(gitRoot);
  
  if (!diffResult.hasChanges) {
    log(chalk.yellow('No changes detected compared to trunk branch. Nothing to review.'));
    return;
  }

  log(chalk.cyan(`Found ${diffResult.changedFiles.length} changed files`));
  log(chalk.gray(`Comparing against: ${diffResult.baseBranch}`));

  // Build the review prompt
  const reviewPrompt = buildReviewPrompt(planData, diffResult);

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
    throw new Error(`Review execution failed: ${err as Error}`);
  }
}

interface DiffResult {
  hasChanges: boolean;
  changedFiles: string[];
  baseBranch: string;
  diffContent: string;
}

export async function generateDiffForReview(gitRoot: string): Promise<DiffResult> {
  const baseBranch = await getTrunkBranch(gitRoot);
  const usingJj = await getUsingJj();
  
  let changedFiles: string[] = [];
  let diffContent = '';

  if (usingJj) {
    // Use jj commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`jj diff --from ${baseBranch} --summary`.cwd(gitRoot).nothrow();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map(line => {
            line = line.trim();
            if (!line || line.startsWith('D')) {
              return '';
            }
            // Handle renames (R old_file new_file)
            if (line.startsWith('R')) {
              const parts = line.split(' ');
              return parts.length >= 3 ? parts[2] : '';
            }
            // Handle additions/modifications (A/M file)
            return line.slice(2);
          })
          .filter(line => !!line);
      }

      // Get full diff content
      const diffResult = await $`jj diff --from ${baseBranch}`.cwd(gitRoot).nothrow();
      if (diffResult.exitCode === 0) {
        diffContent = diffResult.stdout.toString();
      }
    } catch (err) {
      throw new Error(`Failed to generate jj diff: ${err as Error}`);
    }
  } else {
    // Use git commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`git diff --name-only ${baseBranch}`.cwd(gitRoot).nothrow();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map(line => line.trim())
          .filter(line => !!line);
      }

      // Get full diff content
      const diffResult = await $`git diff ${baseBranch}`.cwd(gitRoot).nothrow();
      if (diffResult.exitCode === 0) {
        diffContent = diffResult.stdout.toString();
      }
    } catch (err) {
      throw new Error(`Failed to generate git diff: ${err as Error}`);
    }
  }

  return {
    hasChanges: changedFiles.length > 0,
    changedFiles,
    baseBranch,
    diffContent,
  };
}

export function buildReviewPrompt(planData: PlanSchema, diffResult: DiffResult): string {
  // Get the reviewer agent prompt template
  const reviewerAgent = getReviewerPrompt('', ''); // We'll build context ourselves

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

  diffResult.changedFiles.forEach(file => {
    changedFilesSection.push(`- ${file}`);
  });

  changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');

  // Combine everything into the final prompt
  const contextContent = [
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

  // Use the reviewer agent template with our context
  const reviewerPromptWithContext = getReviewerPrompt(contextContent);
  
  return reviewerPromptWithContext.prompt;
}