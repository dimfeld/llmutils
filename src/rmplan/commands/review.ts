// Command handler for 'rmplan review'
// Analyzes code changes against plan requirements using the reviewer agent

import { $ } from 'bun';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute, resolve, relative, dirname } from 'node:path';
import { getCurrentCommitHash, getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import { readPlanFile, resolvePlanFile, readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getParentChain, getCompletedChildren } from '../utils/hierarchy.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';
import {
  createReviewResult,
  createFormatter,
  type VerbosityLevel,
  type FormatterOptions,
} from '../formatters/review_formatter.js';
import {
  saveReviewResult,
  createReviewsDirectory,
  createGitNote,
  type ReviewMetadata,
} from '../review_persistence.js';
import {
  getIncrementalDiff,
  storeLastReviewMetadata,
  getLastReviewMetadata,
  getIncrementalSummary,
  type IncrementalReviewMetadata,
  type DiffResult,
} from '../incremental_review.js';
import { access, constants } from 'node:fs/promises';
import { statSync } from 'node:fs';

/**
 * Comprehensive error handling for saving review results
 */
async function saveReviewResultWithErrorHandling(
  filePath: string,
  content: string,
  logger: (message: string) => void
): Promise<void> {
  try {
    // Validate file path
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path provided');
    }

    // Check if path is too long (common file system limitation)
    if (filePath.length > 260) {
      throw new Error('File path too long (exceeds 260 characters)');
    }

    // Ensure directory exists with error handling
    const outputDir = dirname(filePath);
    try {
      await mkdir(outputDir, { recursive: true });
    } catch (mkdirErr) {
      if (mkdirErr instanceof Error && (mkdirErr as any).code === 'EEXIST') {
        // Directory already exists, check if it's actually a directory
        try {
          const stat = statSync(outputDir);
          if (!stat.isDirectory()) {
            throw new Error(`Output directory path exists but is not a directory: ${outputDir}`);
          }
        } catch {
          throw new Error(`Cannot access output directory: ${outputDir}`);
        }
      } else {
        throw new Error(`Failed to create output directory: ${(mkdirErr as Error).message}`);
      }
    }

    // Check directory permissions
    try {
      await access(outputDir, constants.W_OK);
    } catch {
      throw new Error(`No write permission for directory: ${outputDir}`);
    }

    // Check available disk space (basic check)
    if (content.length > 100 * 1024 * 1024) {
      // 100MB
      logger(chalk.yellow('Warning: Large review output detected, checking available space...'));
    }

    // Validate content size
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > 50 * 1024 * 1024) {
      // 50MB limit
      throw new Error(
        `Review content too large (${Math.round(contentSize / 1024 / 1024)}MB). Consider reducing verbosity.`
      );
    }

    // Attempt to write file with retry mechanism
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        await writeFile(filePath, content, 'utf-8');
        logger(chalk.green(`Review results saved to: ${filePath}`));
        return;
      } catch (writeErr) {
        retryCount++;
        const errorCode = (writeErr as any)?.code;

        if (errorCode === 'ENOSPC') {
          throw new Error('Insufficient disk space to save review results');
        } else if (errorCode === 'EMFILE' || errorCode === 'ENFILE') {
          if (retryCount < maxRetries) {
            logger(
              chalk.yellow(
                `Temporary file handle exhaustion, retrying... (${retryCount}/${maxRetries})`
              )
            );
            await new Promise((resolve) => setTimeout(resolve, 100 * retryCount)); // Exponential backoff
            continue;
          }
          throw new Error('Too many open files - system resource exhaustion');
        } else if (errorCode === 'EACCES') {
          throw new Error(`Permission denied when writing to: ${filePath}`);
        } else if (errorCode === 'EROFS') {
          throw new Error('Cannot write to read-only file system');
        } else if (retryCount < maxRetries) {
          logger(
            chalk.yellow(
              `Write failed, retrying... (${retryCount}/${maxRetries}): ${(writeErr as Error).message}`
            )
          );
          await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
          continue;
        } else {
          throw writeErr;
        }
      }
    }

    throw new Error(`Failed to write file after ${maxRetries} attempts`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger(chalk.red(`Error saving review results: ${errorMessage}`));

    // Attempt fallback save to current directory
    try {
      const fallbackPath = `review-fallback-${Date.now()}.txt`;
      await writeFile(fallbackPath, content, 'utf-8');
      logger(chalk.yellow(`Fallback save successful: ${fallbackPath}`));
    } catch (fallbackErr) {
      logger(chalk.red(`Fallback save also failed: ${(fallbackErr as Error).message}`));
      logger(chalk.yellow('Review results could not be saved to file.'));
    }
  }
}

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

  // Handle incremental review options
  const incrementalOptions = {
    incremental: options.incremental || options.sinceLastReview,
    sinceLastReview: options.sinceLastReview,
    sinceCommit: options.since,
    planId: planData.id?.toString(),
  };

  // Generate incremental summary if applicable
  let incrementalSummary = null;
  if (incrementalOptions.incremental && planData.id) {
    incrementalSummary = await getIncrementalSummary(gitRoot, planData.id.toString(), []);
    if (incrementalSummary) {
      log(chalk.cyan(`Incremental review mode enabled`));
      log(chalk.gray(`Last review: ${incrementalSummary.lastReviewDate?.toLocaleString()}`));
      if (incrementalSummary.totalFiles === 0) {
        log(chalk.yellow('No changes detected since last review. Nothing new to review.'));
        return;
      }
      log(
        chalk.cyan(
          `Review delta: ${incrementalSummary.newFiles.length} new files, ${incrementalSummary.modifiedFiles.length} modified files`
        )
      );
    }
  }

  // Generate diff against trunk branch or incremental diff
  const diffResult = await generateDiffForReview(gitRoot, incrementalOptions);

  if (!diffResult.hasChanges) {
    const nothingMessage = incrementalOptions.incremental
      ? 'No changes detected since last review. Nothing to review.'
      : 'No changes detected compared to trunk branch. Nothing to review.';
    log(chalk.yellow(nothingMessage));
    return;
  }

  const changedFilesMessage = incrementalOptions.incremental
    ? `Found ${diffResult.changedFiles.length} changed files since last review`
    : `Found ${diffResult.changedFiles.length} changed files`;
  log(chalk.cyan(changedFilesMessage));
  log(chalk.gray(`Comparing against: ${diffResult.baseBranch}`));

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
      log(
        chalk.yellow(
          `Warning: Could not read instructions file from CLI: ${options.instructionsFile}. ${errorMessage}`
        )
      );
    }
  } else if (config.review?.customInstructionsPath) {
    // Fall back to config file instructions
    try {
      const instructionsPath = validateInstructionsFilePath(
        config.review.customInstructionsPath,
        gitRoot
      );
      customInstructions = await readFile(instructionsPath, 'utf-8');
      log(
        chalk.gray(`Using custom instructions from config: ${config.review.customInstructionsPath}`)
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(
        chalk.yellow(
          `Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${errorMessage}`
        )
      );
    }
  }

  // Handle focus areas
  let focusAreas: string[] = [];
  if (options.focus) {
    // CLI focus areas override config
    const rawFocusAreas = options.focus
      .split(',')
      .map((area: string) => area.trim())
      .filter(Boolean);
    try {
      focusAreas = validateFocusAreas(rawFocusAreas);
      log(chalk.gray(`Using focus areas from CLI: ${focusAreas.join(', ')}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(chalk.yellow(`Warning: Invalid focus areas from CLI: ${errorMessage}`));
      focusAreas = [];
    }
  } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
    try {
      focusAreas = validateFocusAreas(config.review.focusAreas);
      log(chalk.gray(`Using focus areas from config: ${focusAreas.join(', ')}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(chalk.yellow(`Warning: Invalid focus areas from config: ${errorMessage}`));
      focusAreas = [];
    }
  }

  // Add focus areas to custom instructions if provided
  if (focusAreas.length > 0) {
    const focusInstruction = `Focus on: ${focusAreas.join(', ')}`;
    customInstructions = customInstructions
      ? `${customInstructions}\n\n${focusInstruction}`
      : focusInstruction;
  }

  // Set up executor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: gitRoot,
    model: options.model,
    interactive: false, // Review mode doesn't need interactivity
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // If the executor wants rmfilter output, that means that we need to send it the diff.
  // TODO rename that flag to something more generic
  const includeDiff = executor.prepareStepOptions?.()?.rmfilter ?? true;

  // Build the review prompt
  const reviewPrompt = buildReviewPrompt(
    planData,
    diffResult,
    includeDiff,
    parentChain,
    completedChildren,
    customInstructions
  );

  // Execute the review
  if (options.dryRun) {
    log(chalk.cyan('\n## Dry Run - Generated Review Prompt\n'));
    log(reviewPrompt);
    log('\n--dry-run mode: Would execute the above prompt');
    return;
  }

  log(chalk.cyan('\n## Executing Code Review\n'));

  // Execute the review with output capture enabled
  try {
    const executorOutput = await executor.execute(reviewPrompt, {
      planId: planData.id?.toString() ?? 'unknown',
      planTitle: planData.title ?? 'Untitled Plan',
      planFilePath: resolvedPlanFile,
      captureOutput: true, // Enable output capture for review
      executionMode: 'simple', // Use simple mode for review-only operation
    });

    // Use the actual executor output for parsing
    const rawOutput = executorOutput || reviewPrompt;

    // Create structured review result
    const reviewResult = createReviewResult(
      planData.id?.toString() ?? 'unknown',
      planData.title ?? 'Untitled Plan',
      diffResult.baseBranch,
      diffResult.changedFiles,
      rawOutput
    );

    // Check if autofix should be performed - with robust issue detection
    const hasIssues = detectIssuesInReview(reviewResult, rawOutput);
    let shouldAutofix = false;
    if (hasIssues) {
      if (!options.autofix && !options.noAutofix) {
        // Prompt user for autofix
        shouldAutofix = await confirm({
          message: 'Issues were found during review. Would you like to automatically fix them?',
          default: false,
        });
      }
    }

    const performAutofix = options.autofix || (shouldAutofix && !options.noAutofix);

    // Determine format and verbosity from options or config
    const outputFormat = options.format || config.review?.outputFormat || 'terminal';
    const verbosity: VerbosityLevel = options.verbosity || 'normal';

    // Validate format
    if (!['json', 'markdown', 'terminal'].includes(outputFormat)) {
      log(chalk.yellow(`Warning: Invalid format '${outputFormat}', using 'terminal'`));
    }

    // Create formatter options
    const formatterOptions: FormatterOptions = {
      verbosity,
      showFiles: options.showFiles !== false && verbosity !== 'minimal',
      showSuggestions: !options.noSuggestions,
      colorEnabled: !options.noColor && outputFormat === 'terminal',
    };

    // Format the review result
    const formatter = createFormatter(
      outputFormat === 'json' || outputFormat === 'markdown' ? outputFormat : 'terminal'
    );
    const formattedOutput = formatter.format(reviewResult, formatterOptions);

    // Persistence logic - save to structured review history
    const shouldSave =
      options.save ||
      (config.review?.autoSave && !options.noSave) ||
      (!options.noSave && !options.outputFile && !config.review?.saveLocation);

    if (shouldSave) {
      try {
        const reviewsDir = await createReviewsDirectory(gitRoot);
        const currentCommitHash = await getCurrentCommitHash(gitRoot);

        if (currentCommitHash) {
          const metadata: ReviewMetadata = {
            planId: planData.id?.toString() ?? 'unknown',
            planTitle: planData.title ?? 'Untitled Plan',
            commitHash: currentCommitHash,
            timestamp: new Date(),
            reviewer: process.env.USER || process.env.USERNAME,
            baseBranch: diffResult.baseBranch,
            changedFiles: diffResult.changedFiles,
          };

          const savedPath = await saveReviewResult(reviewsDir, formattedOutput, metadata);
          log(chalk.cyan(`Review saved to: ${savedPath}`));

          // Create Git note if requested
          if (options.gitNote) {
            const reviewSummary = `Code review completed for plan ${metadata.planId}: ${metadata.planTitle}`;
            const noteCreated = await createGitNote(gitRoot, currentCommitHash, reviewSummary);
            if (noteCreated) {
              log(chalk.cyan('Git note created with review summary'));
            } else {
              log(chalk.yellow('Warning: Could not create Git note'));
            }
          }
        } else {
          log(chalk.yellow('Warning: Could not save review - unable to determine commit hash'));
        }
      } catch (persistenceErr) {
        const persistenceErrorMessage =
          persistenceErr instanceof Error ? persistenceErr.message : String(persistenceErr);
        log(chalk.yellow(`Warning: Could not save review to history: ${persistenceErrorMessage}`));
      }
    }

    // Save to file if requested with comprehensive error handling
    if (options.outputFile) {
      await saveReviewResultWithErrorHandling(options.outputFile, formattedOutput, log);
    } else if (config.review?.saveLocation) {
      // Use config save location if no explicit output file
      try {
        const saveDir = isAbsolute(config.review.saveLocation)
          ? config.review.saveLocation
          : join(gitRoot, config.review.saveLocation);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `review-${planData.id}-${timestamp}${formatter.getFileExtension()}`;
        const savePath = join(saveDir, filename);

        await saveReviewResultWithErrorHandling(savePath, formattedOutput, log);
      } catch (saveErr) {
        const saveErrorMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
        log(chalk.yellow(`Warning: Could not prepare save location: ${saveErrorMessage}`));
      }
    }

    // Display formatted output to console (unless saving to file and format is not terminal)
    if (!options.outputFile || outputFormat === 'terminal') {
      log('\n' + formattedOutput);
    }

    // Store incremental review metadata after successful review
    if (planData.id) {
      try {
        const currentCommitHash = await getCurrentCommitHash(gitRoot);
        if (currentCommitHash) {
          const incrementalMetadata: IncrementalReviewMetadata = {
            lastReviewCommit: currentCommitHash,
            lastReviewTimestamp: new Date(),
            planId: planData.id.toString(),
            baseBranch: diffResult.baseBranch,
            reviewedFiles: diffResult.changedFiles,
            changeCount: diffResult.changedFiles.length,
          };

          await storeLastReviewMetadata(gitRoot, planData.id.toString(), incrementalMetadata);
          if (incrementalOptions.incremental) {
            log(chalk.gray('Incremental review metadata updated for future reviews'));
          }
        }
      } catch (metadataErr) {
        const metadataErrorMessage =
          metadataErr instanceof Error ? metadataErr.message : String(metadataErr);
        log(
          chalk.yellow(
            `Warning: Could not store incremental review metadata: ${metadataErrorMessage}`
          )
        );
      }
    }

    // Execute autofix if requested or confirmed and issues were detected
    if (performAutofix && hasIssues) {
      log(chalk.cyan('\n## Executing Autofix\n'));

      try {
        // Build the autofix prompt with validation
        const autofixPrompt = buildAutofixPrompt(planData, reviewResult, diffResult);

        // Execute autofix using the executor in normal mode
        const autofixOutput = await executor.execute(autofixPrompt, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: `${planData.title ?? 'Untitled Plan'} - Autofix`,
          planFilePath: resolvedPlanFile,
          captureOutput: false, // Allow normal execution output for autofix
          executionMode: 'normal', // Use full-featured mode for autofix
        });

        log(chalk.green('Autofix execution completed successfully!'));
      } catch (autofixErr) {
        // Enhanced error handling with context preservation
        const autofixErrorMessage =
          autofixErr instanceof Error ? autofixErr.message : String(autofixErr);
        const contextualError = `Autofix execution failed: ${autofixErrorMessage}`;

        log(chalk.red(`Error during autofix execution: ${autofixErrorMessage}`));

        // Preserve stack trace for debugging
        if (autofixErr instanceof Error && autofixErr.stack) {
          log(chalk.gray(`Stack trace: ${autofixErr.stack}`));
        }

        throw new Error(contextualError);
      }
    }

    log(chalk.green('\nCode review completed successfully!'));
  } catch (err) {
    // Enhanced error handling with better context preservation
    const errorMessage = err instanceof Error ? err.message : String(err);
    const contextualError = `Review execution failed: ${errorMessage}`;

    // Log additional context for debugging
    if (err instanceof Error) {
      if (err.stack) {
        log(chalk.gray(`Stack trace: ${err.stack}`));
      }

      // Provide specific guidance based on error type
      if (err.message.includes('timeout')) {
        log(
          chalk.yellow(
            'Hint: Consider using a different model or reducing the scope of the review.'
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

/**
 * Validates that a file path is safe to read and within allowed boundaries
 * Prevents path traversal attacks and ensures the path stays within the git root
 */
export function validateInstructionsFilePath(filePath: string, gitRoot: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Instructions file path must be a non-empty string');
  }

  // Resolve the absolute path
  const absolutePath = isAbsolute(filePath) ? filePath : join(gitRoot, filePath);
  const resolvedPath = resolve(absolutePath);
  const resolvedGitRoot = resolve(gitRoot);

  // Ensure the resolved path is within the git root directory
  const relativePath = relative(resolvedGitRoot, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Instructions file path is outside the allowed directory: ${filePath}`);
  }

  // Additional security check: prevent common dangerous paths
  const normalizedPath = resolvedPath.toLowerCase();
  const dangerousPaths = [
    '/etc/',
    '/usr/',
    '/var/',
    '/home/',
    '/root/',
    'c:\\windows\\',
    'c:\\users\\',
  ];
  if (dangerousPaths.some((dangerous) => normalizedPath.includes(dangerous))) {
    throw new Error(`Instructions file path contains dangerous directory: ${filePath}`);
  }

  return resolvedPath;
}

/**
 * Validates and sanitizes focus areas to prevent injection attacks
 */
export function validateFocusAreas(focusAreas: string[]): string[] {
  if (!Array.isArray(focusAreas)) {
    throw new Error('Focus areas must be an array');
  }

  const allowedFocusPattern = /^[a-zA-Z0-9\s._-]+$/;
  const maxFocusAreaLength = 50;
  const maxFocusAreas = 10;

  if (focusAreas.length > maxFocusAreas) {
    throw new Error(`Too many focus areas specified (max ${maxFocusAreas})`);
  }

  const sanitizedAreas = focusAreas
    .map((area) => area.trim())
    .filter((area) => {
      if (!area) return false;
      if (area.length > maxFocusAreaLength) {
        throw new Error(`Focus area too long (max ${maxFocusAreaLength} characters): ${area}`);
      }
      if (!allowedFocusPattern.test(area)) {
        throw new Error(`Focus area contains invalid characters: ${area}`);
      }
      return true;
    });

  return sanitizedAreas;
}

export async function generateDiffForReview(
  gitRoot: string,
  options?: {
    incremental?: boolean;
    sinceLastReview?: boolean;
    sinceCommit?: string;
    planId?: string;
  }
): Promise<DiffResult> {
  // Handle incremental review options
  if (options?.incremental || options?.sinceLastReview) {
    if (!options.planId) {
      throw new Error('Plan ID is required for incremental reviews');
    }

    const lastReviewMetadata = await getLastReviewMetadata(gitRoot, options.planId);
    if (!lastReviewMetadata) {
      // No previous review found, fall back to regular diff
      console.log('No previous review found for incremental mode, generating full diff...');
      return generateRegularDiffForReview(gitRoot);
    }

    return getIncrementalDiff(
      gitRoot,
      lastReviewMetadata.lastReviewCommit,
      lastReviewMetadata.baseBranch
    );
  }

  // Handle explicit since commit
  if (options?.sinceCommit) {
    const baseBranch = await getTrunkBranch(gitRoot);
    if (!baseBranch) {
      throw new Error('Could not determine trunk branch for comparison');
    }
    return getIncrementalDiff(gitRoot, options.sinceCommit, baseBranch);
  }

  // Regular diff generation
  return generateRegularDiffForReview(gitRoot);
}

async function generateRegularDiffForReview(gitRoot: string): Promise<DiffResult> {
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
  includeDiff: boolean = false,
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

  if (includeDiff) {
    changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');
  }

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

/**
 * Robust issue detection that combines multiple methods to determine if issues exist
 */
export function detectIssuesInReview(
  reviewResult: ReturnType<typeof createReviewResult>,
  rawOutput: string
): boolean {
  // Primary method: check totalIssues count
  if (reviewResult?.summary?.totalIssues > 0) {
    return true;
  }

  // Secondary method: check if issues array has content
  if (
    reviewResult?.issues &&
    Array.isArray(reviewResult.issues) &&
    reviewResult.issues.length > 0
  ) {
    return true;
  }

  // Fallback method: semantic analysis of review output
  if (rawOutput) {
    // The reviewer is told to output this verdict if there are issues
    return rawOutput.includes('NEEDS_FIXES');
  }

  return false;
}

/**
 * Creates an autofix prompt that includes the plan context, review findings, and instructions to fix all identified issues
 */
export function buildAutofixPrompt(
  planData: PlanSchema,
  reviewResult: ReturnType<typeof createReviewResult>,
  diffResult: DiffResult
): string {
  // Input validation
  if (!planData) {
    throw new Error('planData is required for autofix prompt generation');
  }
  if (!reviewResult) {
    throw new Error('reviewResult is required for autofix prompt generation');
  }
  if (!diffResult) {
    throw new Error('diffResult is required for autofix prompt generation');
  }
  const prompt = [
    `# Autofix Request`,
    ``,
    `## Plan Context`,
    ``,
    `**Plan ID:** ${planData.id}`,
    `**Title:** ${planData.title}`,
    `**Goal:** ${planData.goal}`,
    ``,
  ];

  if (planData.details) {
    prompt.push(`**Details:**`, planData.details, ``);
  }

  if (planData.tasks && planData.tasks.length > 0) {
    prompt.push(`**Tasks:**`);
    planData.tasks.forEach((task, index) => {
      prompt.push(`${index + 1}. **${task.title}**`);
      if (task.description) {
        prompt.push(`   ${task.description}`);
      }
      prompt.push(``);
    });
  }

  prompt.push(
    `## Review Findings`,
    ``,
    `A code review has identified the following issues that need to be fixed:`,
    ``
  );

  // Add issues from the review result
  if (reviewResult.issues && reviewResult.issues.length > 0) {
    reviewResult.issues.forEach((issue, index) => {
      prompt.push(`### Issue ${index + 1}: ${issue.title || 'Unnamed Issue'}`);
      if (issue.description) {
        prompt.push(issue.description);
      }
      if (issue.file) {
        prompt.push(`**File:** ${issue.file}`);
      }
      if (issue.severity) {
        prompt.push(`**Severity:** ${issue.severity}`);
      }
      prompt.push(``);
    });
  } else {
    // Fallback if structured issues aren't available - include the raw review output
    prompt.push(`**Review Output:**`);
    prompt.push(reviewResult.rawOutput || 'No specific issues identified in structured format.');
    prompt.push(``);
  }

  prompt.push(
    `## Files to Fix`,
    ``,
    `**Base Branch:** ${diffResult.baseBranch}`,
    `**Changed Files:**`
  );

  diffResult.changedFiles.forEach((file) => {
    prompt.push(`- ${file}`);
  });

  prompt.push(
    ``,
    `## Instructions`,
    ``,
    `Please fix all the issues identified in the review while maintaining the plan requirements. Ensure that:`,
    ``,
    `1. All identified bugs and issues are resolved`,
    `2. The code still fulfills the plan's goals and tasks`,
    `3. Code quality is improved according to the review feedback`,
    `4. All existing functionality is preserved`,
    `5. Proper error handling is maintained or improved`,
    `6. Tests are updated if necessary`,
    ``,
    `Focus on making targeted fixes that address the specific issues found during the review.`
  );

  return prompt.join('\n');
}
