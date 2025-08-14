// Command handler for 'rmplan description'
// Generates comprehensive pull request descriptions from plan context and code changes

import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getPrDescriptionPrompt } from '../executors/claude_code/agent_prompts.js';
import { gatherPlanContext } from '../utils/context_gathering.js';
import type { PlanContext } from '../utils/context_gathering.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';

/**
 * Options for the description command
 */
interface DescriptionOptions {
  executor?: string;
  model?: string;
  dryRun?: boolean;
  instructions?: string;
  instructionsFile?: string;
}

/**
 * Command object with parent access for global options
 */
interface DescriptionCommand {
  parent: {
    opts(): {
      config?: string;
    };
  };
}

/**
 * Builds the PR description prompt using the provided context and custom instructions
 */
export function buildPrDescriptionPrompt(
  context: PlanContext,
  customInstructions?: string
): string {
  const { planData, parentChain, completedChildren, diffResult } = context;

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
      `*Note: This PR implements part of the parent plan${parentChain.length > 1 ? 's' : ''} above.*`,
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
      `*Note: This PR builds upon the completed child plans above.*`,
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
    `# Code Changes Implemented`,
    ``,
    `**Base Branch:** ${diffResult.baseBranch}`,
    `**Changed Files (${diffResult.changedFiles.length}):**`,
  ];

  diffResult.changedFiles.forEach((file) => {
    changedFilesSection.push(`- ${file}`);
  });

  // Always include diff for description generation
  changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');

  // Combine everything into the final context content
  const contextContent = [
    ...parentContext,
    ...childrenContext,
    ...planContext,
    ``,
    ...changedFilesSection,
    ``,
  ].join('\n');

  // Use the PR description agent template with our context and custom instructions
  const prDescriptionPromptDefinition = getPrDescriptionPrompt(contextContent, customInstructions || '');

  return prDescriptionPromptDefinition.prompt;
}

/**
 * Main handler for the rmplan description command
 */
export async function handleDescriptionCommand(
  planFile: string, 
  options: DescriptionOptions, 
  command: DescriptionCommand
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Gather plan context using the shared utility
  // Description command doesn't use incremental features, so pass empty review options
  const context = await gatherPlanContext(planFile, {}, globalOpts);

  // Check if no changes were detected and early return
  if (context.noChangesDetected) {
    log(chalk.yellow('No changes detected compared to trunk branch. Nothing to describe.'));
    return;
  }

  // Extract context for use in the rest of the function
  const { resolvedPlanFile, planData, diffResult } = context;

  log(chalk.green(`Generating PR description for plan: ${planData.id} - ${planData.title}`));

  // Get git root for file operations
  const gitRoot = await getGitRoot();

  // Load custom instructions
  let customInstructions = '';

  // First try CLI options (CLI takes precedence)
  if (options.instructions) {
    customInstructions = options.instructions;
    log(chalk.gray('Using inline custom instructions from CLI'));
  } else if (options.instructionsFile) {
    try {
      const instructionsPath = validateInstructionsFilePath(options.instructionsFile, gitRoot);
      customInstructions = await readFile(instructionsPath, 'utf-8');
      log(chalk.gray(`Using custom instructions from CLI file: ${options.instructionsFile}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      // Different error handling based on error type
      if (err instanceof Error && err.message.includes('outside the allowed directory')) {
        // Security error - fail fast
        throw new Error(`Security error: ${errorMessage}`);
      } else if (err instanceof Error && (err as any).code === 'ENOENT') {
        // File not found - fail fast since user explicitly provided the file
        throw new Error(`Instructions file not found: ${options.instructionsFile}. Please check the file path.`);
      } else if (err instanceof Error && (err as any).code === 'EACCES') {
        // Permission error - fail fast  
        throw new Error(`Cannot read instructions file: ${options.instructionsFile}. Permission denied.`);
      } else {
        // Other errors - warn but continue, with clear indication that instructions will be empty
        log(
          chalk.yellow(
            `Warning: Could not read instructions file '${options.instructionsFile}': ${errorMessage}`
          )
        );
        log(chalk.yellow('Continuing without custom instructions.'));
      }
    }
  }

  // Set up executor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: gitRoot,
    model: options.model,
    interactive: false, // Description generation doesn't need interactivity
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // Build the PR description prompt
  const prDescriptionPrompt = buildPrDescriptionPrompt(context, customInstructions);

  // Execute the description generation
  if (options.dryRun) {
    log(chalk.cyan('\n## Dry Run - Generated PR Description Prompt\n'));
    log(prDescriptionPrompt);
    log('\n--dry-run mode: Would execute the above prompt');
    return;
  }

  log(chalk.cyan('\n## Generating PR Description\n'));

  // Execute the description generation
  try {
    const executorOutput = await executor.execute(prDescriptionPrompt, {
      planId: planData.id?.toString() ?? 'unknown',
      planTitle: planData.title ?? 'Untitled Plan',
      planFilePath: resolvedPlanFile,
      captureOutput: 'result', // Capture only the final result block for description
      executionMode: 'simple', // Use simple mode for description-only operation
    });

    // Use the actual executor output
    const generatedDescription = executorOutput || 'No description generated';

    // Display the generated description
    log('\n' + chalk.bold('Generated PR Description:'));
    log('\n' + generatedDescription);

    log(chalk.green('\nPR description generated successfully!'));
  } catch (err) {
    // Enhanced error handling with better context preservation
    const errorMessage = err instanceof Error ? err.message : String(err);
    const contextualError = `Description generation failed: ${errorMessage}`;

    // Log additional context for debugging
    if (err instanceof Error) {
      if (err.stack) {
        log(chalk.gray(`Stack trace: ${err.stack}`));
      }

      // Provide specific guidance based on error type
      if (err.message.includes('timeout')) {
        log(
          chalk.yellow(
            'Hint: Consider using a different model or reducing the scope of the changes.'
          )
        );
      } else if (err.message.includes('permission')) {
        log(
          chalk.yellow('Hint: Check file permissions and ensure you have access to the repository.')
        );
      } else if (err.message.includes('network')) {
        log(chalk.yellow('Hint: Check your internet connection and API credentials.'));
      }
    }

    throw new Error(contextualError);
  }
}