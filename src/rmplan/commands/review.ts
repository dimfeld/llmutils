// Command handler for 'rmplan review'
// Analyzes code changes against plan requirements using the reviewer agent

import chalk from 'chalk';
import { checkbox, select } from '@inquirer/prompts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve, relative } from 'node:path';
import { getCurrentCommitHash, getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import { findBranchSpecificPlan, writePlanFile } from '../plans.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';
import { gatherPlanContext } from '../utils/context_gathering.js';
import {
  createReviewResult,
  createFormatter,
  type VerbosityLevel,
  type FormatterOptions,
  type ReviewIssue,
} from '../formatters/review_formatter.js';
import {
  saveReviewResult,
  createReviewsDirectory,
  createGitNote,
  type ReviewMetadata,
} from '../review_persistence.js';
import {
  storeLastReviewMetadata,
  getLastReviewMetadata,
  getIncrementalDiff,
  type IncrementalReviewMetadata,
  type DiffResult,
} from '../incremental_review.js';
import { access, constants } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import { createCleanupPlan, type CleanupPlanOptions } from '../utils/cleanup_plan_creator.js';

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

export async function handleReviewCommand(
  planFile: string | undefined,
  options: any,
  command: any
) {
  const isInteractiveEnv = process.env.RMPLAN_INTERACTIVE !== '0';
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // If no planFile is provided, try to auto-select one from branch-specific plans
  let resolvedPlanFile = planFile;
  if (!resolvedPlanFile) {
    const autoSelectedPlan = await findBranchSpecificPlan(globalOpts.config);

    if (!autoSelectedPlan) {
      throw new Error(
        'No plan file specified and no plans found that are unique to this branch. ' +
          'Please specify a plan file explicitly.'
      );
    }

    resolvedPlanFile = autoSelectedPlan.filename;
    log(chalk.cyan(`Auto-selected plan: ${autoSelectedPlan.id} - ${autoSelectedPlan.title}`));
    log(chalk.gray(`Plan file: ${autoSelectedPlan.filename}`));
  }

  // Gather plan context using the shared utility
  const context = await gatherPlanContext(resolvedPlanFile, options, globalOpts);

  // Check if no changes were detected and early return for review
  if (context.noChangesDetected) {
    const nothingMessage =
      options.incremental || options.sinceLastReview
        ? 'No changes detected since last review. Nothing new to review.'
        : 'No changes detected compared to trunk branch. Nothing to review.';
    log(chalk.yellow(nothingMessage));
    return;
  }

  // Extract context for use in the rest of the function
  const {
    resolvedPlanFile: contextPlanFile,
    planData,
    parentChain,
    completedChildren,
    diffResult,
  } = context;

  log(chalk.green(`Reviewing plan: ${planData.id} - ${planData.title}`));

  // Get git root for the rest of the function (needed for file operations)
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
  const useSubagents = executor.supportsSubagents === true;

  // Build the review prompt
  const reviewPrompt = buildReviewPrompt(
    planData,
    diffResult,
    includeDiff,
    useSubagents,
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
      captureOutput: 'result', // Capture only the final result block for review
      executionMode: 'review', // Use review mode for review-only operation
    });

    // Use the actual executor output for parsing
    const rawOutput =
      typeof executorOutput === 'string'
        ? executorOutput
        : (executorOutput?.content ?? reviewPrompt);

    // Create structured review result
    const reviewResult = createReviewResult(
      planData.id?.toString() ?? 'unknown',
      planData.title ?? 'Untitled Plan',
      diffResult.baseBranch,
      diffResult.changedFiles,
      rawOutput
    );

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

    // Display formatted output to console (unless saving to file and format is not terminal)
    if (!options.outputFile || outputFormat === 'terminal') {
      log('\n' + formattedOutput);
    }

    // Check if autofix should be performed - with robust issue detection
    const hasIssues = detectIssuesInReview(reviewResult, rawOutput);
    let shouldAutofix = false;
    let shouldCreateCleanupPlan = false;
    let shouldAppendTasksToPlan = false;
    let selectedIssues: ReviewIssue[] | null = null;

    if (hasIssues) {
      if (options.autofix || options.autofixAll) {
        shouldAutofix = true;
        if (!options.autofixAll && reviewResult.issues && reviewResult.issues.length > 0) {
          // Allow selection unless --autofix-all is used
          if (isInteractiveEnv) {
            selectedIssues = await selectIssuesToFix(reviewResult.issues, 'fix');
          } else {
            selectedIssues = reviewResult.issues;
          }
          shouldAutofix = selectedIssues.length > 0;
          if (!shouldAutofix) {
            log(chalk.yellow('No issues selected for autofix.'));
          }
        }
      } else if (options.createCleanupPlan) {
        shouldCreateCleanupPlan = true;
        if (reviewResult.issues && reviewResult.issues.length > 0) {
          if (isInteractiveEnv) {
            selectedIssues = await selectIssuesToFix(
              reviewResult.issues,
              'include in cleanup plan'
            );
          } else {
            selectedIssues = reviewResult.issues;
          }
          shouldCreateCleanupPlan = selectedIssues.length > 0;
          if (!shouldCreateCleanupPlan) {
            log(chalk.yellow('No issues selected for cleanup plan.'));
          }
        }
      } else if (!options.noAutofix) {
        // Prompt user for action when interactive; otherwise skip prompting
        let action: 'fix' | 'cleanup' | 'append' | 'exit' = 'exit';
        if (isInteractiveEnv) {
          action = await select({
            message: 'Issues were found during review. What would you like to do?',
            choices: [
              { name: 'Fix now (apply fixes immediately)', value: 'fix' },
              { name: 'Create a cleanup plan (for later execution)', value: 'cleanup' },
              { name: 'Append issues to the current plan as tasks', value: 'append' },
              { name: 'Exit (do nothing)', value: 'exit' },
            ],
            default: 'exit',
          });
        } else {
          log(chalk.gray('Non-interactive environment detected; skipping fix/cleanup prompts.'));
        }

        if (action === 'fix') {
          shouldAutofix = true;
          if (reviewResult.issues && reviewResult.issues.length > 0) {
            selectedIssues = await selectIssuesToFix(reviewResult.issues, 'fix');
            shouldAutofix = selectedIssues.length > 0;
            if (!shouldAutofix) {
              log(chalk.yellow('No issues selected for autofix.'));
            }
          }
        } else if (action === 'cleanup') {
          shouldCreateCleanupPlan = true;
          if (reviewResult.issues && reviewResult.issues.length > 0) {
            selectedIssues = await selectIssuesToFix(
              reviewResult.issues,
              'include in cleanup plan'
            );
            shouldCreateCleanupPlan = selectedIssues.length > 0;
            if (!shouldCreateCleanupPlan) {
              log(chalk.yellow('No issues selected for cleanup plan.'));
            }
          }
        } else if (action === 'append') {
          shouldAppendTasksToPlan = true;
          if (reviewResult.issues && reviewResult.issues.length > 0) {
            selectedIssues = await selectIssuesToFix(reviewResult.issues, 'append as plan tasks');
            shouldAppendTasksToPlan = selectedIssues.length > 0;
            if (!shouldAppendTasksToPlan) {
              log(chalk.yellow('No issues selected to append as tasks.'));
            }
          }
        } else {
          log(chalk.gray('No action taken.'));
        }
      }
    }

    const performAutofix = shouldAutofix && !options.noAutofix;

    if (shouldAppendTasksToPlan && hasIssues) {
      const issuesToAppend =
        (selectedIssues && selectedIssues.length > 0 ? selectedIssues : reviewResult.issues) || [];

      if (issuesToAppend.length === 0) {
        log(chalk.yellow('No review issues available to append as tasks.'));
      } else {
        try {
          const appendedCount = await appendIssuesToPlanTasks(
            contextPlanFile,
            planData,
            issuesToAppend
          );

          if (appendedCount > 0) {
            const plural = appendedCount === 1 ? '' : 's';
            log(
              chalk.green(
                `✓ Added ${appendedCount} review issue${plural} as task${plural} to the plan.`
              )
            );
          } else {
            log(chalk.gray('No new tasks were added (likely due to duplicate titles).'));
          }
        } catch (appendErr) {
          const appendMessage = appendErr instanceof Error ? appendErr.message : String(appendErr);
          log(chalk.red(`Error appending review issues to plan tasks: ${appendMessage}`));
        }
      }
    }

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
          if (options.incremental || options.sinceLastReview) {
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

    // Create cleanup plan if requested
    if (shouldCreateCleanupPlan && hasIssues && planData.id) {
      log(chalk.cyan('\n## Creating Cleanup Plan\n'));

      try {
        const cleanupOptions: CleanupPlanOptions = {
          priority: options.cleanupPriority || 'medium',
          assign: options.cleanupAssign,
        };

        const cleanupResult = await createCleanupPlan(
          planData.id,
          selectedIssues || reviewResult.issues || [],
          cleanupOptions,
          globalOpts
        );

        log(
          chalk.green(
            `✓ Created cleanup plan: ${cleanupResult.filePath} for ID ${chalk.green(cleanupResult.planId)}`
          )
        );
        log(
          chalk.gray(
            `  Next step: Use "rmplan generate ${cleanupResult.planId}" or "rmplan run ${cleanupResult.planId}"`
          )
        );
      } catch (cleanupErr) {
        const cleanupErrorMessage =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        log(chalk.red(`Error creating cleanup plan: ${cleanupErrorMessage}`));
        throw new Error(`Cleanup plan creation failed: ${cleanupErrorMessage}`);
      }
    }

    // Execute autofix if requested or confirmed and issues were detected
    if (performAutofix && hasIssues) {
      log(chalk.cyan('\n## Executing Autofix\n'));

      try {
        // Build the autofix prompt with validation
        const autofixPrompt = buildAutofixPrompt(
          planData,
          reviewResult,
          diffResult,
          selectedIssues
        );

        // Execute autofix using the executor in normal mode
        const autofixOutput = await executor.execute(autofixPrompt, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: `${planData.title ?? 'Untitled Plan'} - Autofix`,
          planFilePath: resolvedPlanFile,
          captureOutput: 'none', // Allow normal execution output for autofix
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

/**
 * Prompts the user to select which issues to address from the review results
 * (issues can be either fixed immediately or included in a cleanup plan)
 */
async function selectIssuesToFix(
  issues: ReviewIssue[],
  purpose: string = 'fix'
): Promise<ReviewIssue[]> {
  const isInteractiveEnv = process.env.RMPLAN_INTERACTIVE !== '0';
  if (!isInteractiveEnv) {
    return issues;
  }
  // Group issues by severity for better organization
  const groupedIssues = issues.reduce(
    (acc, issue) => {
      if (!acc[issue.severity]) acc[issue.severity] = [];
      acc[issue.severity].push(issue);
      return acc;
    },
    {} as Record<string, ReviewIssue[]>
  );

  // Create checkbox options with severity indicators
  const options = [];
  const severityOrder = ['critical', 'major', 'minor', 'info'] as const;
  const severityIcons: Record<string, string> = {
    critical: '🔴',
    major: '🟠',
    minor: '🟡',
    info: 'ℹ️',
  };

  for (const severity of severityOrder) {
    const severityIssues = groupedIssues[severity] || [];
    for (const issue of severityIssues) {
      const fileInfo = issue.file ? ` (${issue.file}${issue.line ? ':' + issue.line : ''})` : '';

      const firstLine = issue.content.split('\n')[0];
      const fullDesc = issue.content + fileInfo;

      options.push({
        name: `${severityIcons[severity]} [${severity.toUpperCase()}] ${firstLine}`,
        description: fullDesc,
        value: issue,
        checked: severity === 'critical' || severity === 'major', // Pre-select critical and major issues
      });
    }
  }

  const selectedIssues = await checkbox({
    message: `Select issues to ${purpose}:`,
    choices: options,
    pageSize: 15,
    loop: false,
  });

  return selectedIssues;
}

type PlanTask = PlanSchema['tasks'][number];

function buildTaskTitleFromIssue(issue: ReviewIssue): string {
  const firstMeaningfulLine = issue.content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  let normalized = (firstMeaningfulLine || 'Review feedback').replace(/\s+/g, ' ');
  const MAX_BODY_LENGTH = 100;
  if (normalized.length > MAX_BODY_LENGTH) {
    normalized = `${normalized.slice(0, MAX_BODY_LENGTH - 3).trimEnd()}...`;
  }

  if (!/[.!?]$/.test(normalized)) {
    normalized += '.';
  }

  return `Address Review Feedback: ${normalized}`;
}

function createTaskFromIssue(issue: ReviewIssue): PlanTask {
  const title = buildTaskTitleFromIssue(issue);

  const descriptionSegments: string[] = [];
  const trimmedContent = issue.content.trim();
  if (trimmedContent) {
    descriptionSegments.push(trimmedContent);
  } else {
    descriptionSegments.push('Follow up on review feedback.');
  }

  if (issue.suggestion) {
    descriptionSegments.push('', `Suggestion: ${issue.suggestion}`);
  }

  if (issue.file) {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    descriptionSegments.push('', `Related file: ${location}`);
  }

  const description = descriptionSegments.join('\n').trim();

  const task: PlanTask = {
    title,
    description,
    done: false,
  };

  return task;
}

async function appendIssuesToPlanTasks(
  planFilePath: string,
  planData: PlanSchema,
  issues: ReviewIssue[]
): Promise<number> {
  if (!Array.isArray(planData.tasks)) {
    planData.tasks = [];
  }

  const existingTitles = new Set(planData.tasks.map((task) => task.title));
  let appendedCount = 0;

  for (const issue of issues) {
    const task = createTaskFromIssue(issue);
    if (existingTitles.has(task.title)) {
      continue;
    }

    planData.tasks.push(task);
    existingTitles.add(task.title);
    appendedCount++;
  }

  if (appendedCount > 0) {
    if (planData.status === 'done') {
      planData.status = 'in_progress';
    }
    await writePlanFile(planFilePath, planData);
  }

  return appendedCount;
}

export function buildReviewPrompt(
  planData: PlanSchema,
  diffResult: DiffResult,
  includeDiff: boolean = false,
  useSubagents: boolean = false,
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
  const reviewerPromptWithContext = getReviewerPrompt(
    contextContent,
    planData.id,
    customInstructions,
    undefined,
    useSubagents
  );

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
    // Check for explicit verdict from reviewer
    if (rawOutput.includes('NEEDS_FIXES')) {
      return true;
    }

    // Check for common issue indicators
    const issueIndicators = [
      'issues were found',
      'issues need to be addressed',
      'problems identified',
      'bugs found',
      'vulnerabilities detected',
      'security issue',
      'critical',
      'error handling',
      'memory leak',
      'performance bottleneck',
      'missing error handling',
      'needs to be fixed',
      'requires attention',
    ];

    const lowerOutput = rawOutput.toLowerCase();
    return issueIndicators.some((indicator) => lowerOutput.includes(indicator));
  }

  return false;
}

/**
 * Creates an autofix prompt that includes the plan context, review findings, and instructions to fix all identified issues
 */
export function buildAutofixPrompt(
  planData: PlanSchema,
  reviewResult: ReturnType<typeof createReviewResult>,
  diffResult: DiffResult,
  selectedIssues?: ReviewIssue[] | null
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
  const issuesToFix = selectedIssues || reviewResult.issues;

  if (issuesToFix && issuesToFix.length > 0) {
    // Add note if subset selected
    if (
      selectedIssues &&
      reviewResult.issues &&
      selectedIssues.length < reviewResult.issues.length
    ) {
      prompt.push(
        `Note: ${selectedIssues.length} of ${reviewResult.issues.length} issues selected for fixing.`,
        ``
      );
    }

    issuesToFix.forEach((issue, index) => {
      prompt.push(`### Issue ${index + 1}: ${issue.content || 'Unnamed Issue'}`);
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
