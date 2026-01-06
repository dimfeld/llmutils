// Command handler for 'rmplan description'
// Generates comprehensive pull request descriptions from plan context and code changes

import chalk from 'chalk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { write } from '../../common/clipboard.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { select, input, checkbox } from '@inquirer/prompts';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getPrDescriptionPrompt } from '../executors/claude_code/agent_prompts.js';
import { gatherPlanContext } from '../utils/context_gathering.js';
import type { PlanContext } from '../utils/context_gathering.js';
import {
  validateInstructionsFilePath,
  validateOutputFilePath,
  sanitizeProcessInput,
  validateDescriptionOptions,
  sanitizeTitlePrefix,
} from '../utils/file_validation.js';

/**
 * Options for the description command
 */
interface DescriptionOptions {
  executor?: string;
  model?: string;
  dryRun?: boolean;
  instructions?: string;
  instructionsFile?: string;
  base?: string;
  outputFile?: string;
  copy?: boolean;
  createPr?: boolean;
  [key: string]: unknown;
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

    childrenContext.push(`*Note: This PR builds upon the completed child plans above.*`, ``, ``);
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
      const status = task.done ? '✓' : '○';
      planContext.push(`${status} ${index + 1}. **${task.title}**`);
      if (task.description) {
        planContext.push(`   ${task.description}`);
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
  const prDescriptionPromptDefinition = getPrDescriptionPrompt(
    contextContent,
    customInstructions || ''
  );

  return prDescriptionPromptDefinition.prompt;
}

/**
 * Shared helper function to write file output safely
 */
async function writeFileOutput(filePath: string, content: string, gitRoot: string): Promise<void> {
  const validatedPath = validateOutputFilePath(filePath, gitRoot);
  await mkdir(dirname(validatedPath), { recursive: true });
  await writeFile(validatedPath, content, 'utf-8');
  log(chalk.green(`Description saved to: ${filePath}`));
}

/**
 * Shared helper function to copy content to clipboard safely
 */
async function copyToClipboard(content: string): Promise<void> {
  await write(content);
  log(chalk.green('Description copied to clipboard'));
}

/**
 * Configuration options for PR creation
 */
interface PrCreationOptions {
  /** Whether the PR should be created as a draft */
  draft?: boolean;
  /** Prefix to add to the PR title */
  titlePrefix?: string;
}

/**
 * Shared helper function to create PR safely
 */
async function createPullRequest(
  title: string,
  description: string,
  options: PrCreationOptions = {}
): Promise<void> {
  const sanitizedDescription = sanitizeProcessInput(description);

  // Apply title prefix if configured (already sanitized at config loading stage)
  let finalTitle = title;
  if (options.titlePrefix) {
    finalTitle = `${options.titlePrefix}${title}`;
  }

  // Ensure title doesn't exceed GitHub's PR title limit of 256 characters
  // Account for the entire command line - gh command + arguments + title
  const baseCommandLength = 'gh pr create --draft --title --body-file -'.length + 10; // Add buffer
  const maxTitleLength = 256 - baseCommandLength;
  if (finalTitle.length > maxTitleLength) {
    finalTitle = finalTitle.substring(0, maxTitleLength).trim();
  }

  // Build command arguments conditionally
  const ghArgs = ['gh', 'pr', 'create'];

  // Only add --draft flag if draft is explicitly true
  if (options.draft === true) {
    ghArgs.push('--draft');
  }

  ghArgs.push('--title', finalTitle, '--body-file', '-');

  const result = await spawnAndLogOutput(ghArgs, {
    stdin: sanitizedDescription,
  });

  if (result.exitCode === 0) {
    log(chalk.green('GitHub PR created successfully'));
  } else {
    throw new Error(`gh command failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
}

/**
 * Handles output actions for the generated description with comprehensive error handling
 */
async function handleOutputActions(
  title: string,
  description: string,
  options: DescriptionOptions,
  gitRoot: string,
  prCreationConfig: PrCreationOptions
): Promise<void> {
  // Check if any direct output flags are provided
  const hasDirectOutputFlags = options.outputFile || options.copy || options.createPr;

  if (hasDirectOutputFlags) {
    // Collect all errors to handle partial failures gracefully
    const errors: string[] = [];

    // Handle file output
    if (options.outputFile) {
      try {
        await writeFileOutput(options.outputFile, description, gitRoot);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to write description to file: ${errorMessage}`);
      }
    }

    // Handle clipboard copy
    if (options.copy) {
      try {
        await copyToClipboard(description);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to copy description to clipboard: ${errorMessage}`);
      }
    }

    // Handle PR creation
    if (options.createPr) {
      try {
        await createPullRequest(title, description, prCreationConfig);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to create GitHub PR: ${errorMessage}`);
      }
    }

    // If any errors occurred, throw a comprehensive error
    if (errors.length > 0) {
      throw new Error(`Output operations failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    }
  } else {
    // Show interactive prompt when no output flags are provided
    await handleInteractiveOutput(title, description, gitRoot, prCreationConfig);
  }
}

/**
 * Handles interactive output prompt when no direct flags are provided with consistent error handling
 */
async function handleInteractiveOutput(
  title: string,
  description: string,
  gitRoot: string,
  prCreationConfig: PrCreationOptions
): Promise<void> {
  try {
    const action = await select({
      message: 'What would you like to do with the generated description?',
      choices: [
        { name: 'Copy to clipboard', value: 'copy' },
        { name: 'Save to file', value: 'save' },
        { name: 'Create GitHub PR', value: 'pr' },
        { name: 'None (just display)', value: 'none' },
      ],
    });

    if (action === 'none') {
      log(chalk.gray('No additional actions selected.'));
      return;
    }

    // Handle the single selected action
    try {
      switch (action) {
        case 'copy':
          await copyToClipboard(description);
          log(chalk.green('Copied to clipboard'));
          break;

        case 'save': {
          const filename = await input({
            message: 'Enter filename to save the description:',
            default: 'pr-description.md',
          });

          if (filename && filename.trim()) {
            await writeFileOutput(filename.trim(), description, gitRoot);
          } else {
            log(chalk.yellow('File save cancelled - no filename provided.'));
          }
          break;
        }

        case 'pr':
          await createPullRequest(title, description, prCreationConfig);
          log(chalk.green('GitHub PR created successfully'));
          break;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // For interactive mode, provide specific error context
      const actionName =
        action === 'copy'
          ? 'copy to clipboard'
          : action === 'save'
            ? 'save file'
            : action === 'pr'
              ? 'create GitHub PR'
              : action;

      const formattedError = `Failed to ${actionName}: ${errorMessage}`;
      log(chalk.red(formattedError));
      throw new Error(formattedError);
    }
  } catch (err) {
    // Handle prompt cancellation and other interactive errors gracefully
    if (err instanceof Error && err.name === 'ExitPromptError') {
      log(chalk.gray('Action cancelled by user.'));
    } else {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(chalk.red(`Interactive prompt failed: ${errorMessage}`));
    }
  }
}

/**
 * Main handler for the rmplan description command
 */
export async function handleDescriptionCommand(
  planFile: string,
  options: DescriptionOptions,
  command: DescriptionCommand
) {
  // Validate CLI options early to prevent runtime errors
  validateDescriptionOptions(options);

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Extract prCreation settings with proper defaults for partial configuration
  const prCreationConfig = {
    draft: true, // Default to draft mode for backward compatibility
    titlePrefix: undefined,
    ...config.prCreation, // Override with actual config values
  };

  // Sanitize title prefix at config loading stage if provided
  if (prCreationConfig.titlePrefix) {
    prCreationConfig.titlePrefix = sanitizeTitlePrefix(prCreationConfig.titlePrefix);
  }

  // Gather plan context using the shared utility
  // Description command doesn't use incremental features, so pass empty review options
  const context = await gatherPlanContext(planFile, { base: options.base }, globalOpts);

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
        throw new Error(
          `Instructions file not found: ${options.instructionsFile}. Please check the file path.`
        );
      } else if (err instanceof Error && (err as any).code === 'EACCES') {
        // Permission error - fail fast
        throw new Error(
          `Cannot read instructions file: ${options.instructionsFile}. Permission denied.`
        );
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
      executionMode: 'bare', // Use bare mode for single-prompt operation
    });

    // Use the actual executor output (support structured or string)
    const generatedDescription =
      typeof executorOutput === 'string'
        ? executorOutput
        : (executorOutput?.content ?? 'No description generated');

    // Display the generated description
    log('\n' + chalk.bold('Generated PR Description:'));
    log('\n' + generatedDescription);

    // Handle output actions based on CLI flags
    await handleOutputActions(
      planData.title || `Plan ${planData.id}`,
      generatedDescription,
      options,
      gitRoot,
      prCreationConfig
    );

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
