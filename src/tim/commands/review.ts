// Command handler for 'tim review'
// Analyzes code changes against plan requirements using the reviewer agent

import chalk from 'chalk';
import { checkbox, select } from '@inquirer/prompts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve, relative } from 'node:path';
import { getCurrentCommitHash, getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import {
  findBranchSpecificPlan,
  findSingleModifiedPlanOnBranch,
  readPlanFile,
  writePlanFile,
} from '../plans.js';
import { log, warn, runWithLogger, sendStructured } from '../../logging.js';
import { getLoggerAdapter, type LoggerAdapter } from '../../logging/adapter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import { formatStructuredMessage } from '../../logging/console_formatter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig, loadGlobalConfigForNotifications } from '../configLoader.js';
import { getDefaultConfig } from '../configSchema.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import { sendNotification } from '../notifications.js';
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
import {
  prepareReviewExecutors,
  runReview,
  type ReviewExecutorName,
  type ReviewPromptBuilder,
} from '../review_runner.js';
import { createHeadlessAdapterForCommand } from '../headless.js';
import { timestamp } from './agent/agent_helpers.js';
import which from 'which';
const FIX_EXECUTOR_COMMANDS = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
} as const satisfies Record<ReviewExecutorName, string>;
type FixAction = 'fix-claude' | 'fix-codex';
const FIX_ACTION_EXECUTOR_MAP: Record<FixAction, ReviewExecutorName> = {
  'fix-claude': 'claude-code',
  'fix-codex': 'codex-cli',
};
const FIX_ACTION_LABELS: Record<FixAction, string> = {
  'fix-claude': 'Fix now with Claude (apply fixes immediately)',
  'fix-codex': 'Fix now with Codex (apply fixes immediately)',
};
import { createCleanupPlan, type CleanupPlanOptions } from '../utils/cleanup_plan_creator.js';

/**
 * Result returned from handleReviewCommand indicating what actions were taken
 */
export interface ReviewCommandResult {
  /** Number of tasks appended to the plan from review issues */
  tasksAppended: number;
}

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

/** Logger for --print --verbose mode: outputs progress to stderr */
const reviewPrintVerboseLogger: LoggerAdapter = {
  log: (...args: any[]) => {
    console.error(...args);
  },
  warn: (...args: any[]) => {
    console.warn(...args);
  },
  error: (...args: any[]) => {
    console.error(...args);
  },
  writeStdout: (data: string) => {
    process.stderr.write(data);
  },
  writeStderr: (data: string) => {
    process.stderr.write(data);
  },
  debugLog: (...args: any[]) => {
    console.error(...args);
  },
  sendStructured: (message: StructuredMessage) => {
    const formatted = formatStructuredMessage(message);
    if (formatted.length > 0) {
      console.error(formatted);
    }
  },
};

/** Quiet logger for --print mode (no --verbose): suppresses all output */
const reviewPrintQuietLogger: LoggerAdapter = {
  log: () => {},
  warn: () => {},
  error: () => {},
  writeStdout: () => {},
  writeStderr: () => {},
  debugLog: () => {},
  sendStructured: () => {},
};

function debugStdinTrace(message: string): void {
  if (process.env.TIM_DEBUG_STDIN !== '1') {
    return;
  }

  const ts = new Date().toISOString();
  try {
    process.stderr.write(`[TIM_DEBUG_STDIN] ${ts} review ${message}\n`);
  } catch {
    // Best-effort debug logging only.
  }
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await which(command, { nothrow: true });
  return Boolean(result);
}

async function getAvailableFixActions(): Promise<
  Array<{ action: FixAction; executor: ReviewExecutorName; label: string }>
> {
  const results = await Promise.all(
    (Object.entries(FIX_ACTION_EXECUTOR_MAP) as Array<[FixAction, ReviewExecutorName]>).map(
      async ([action, executor]) => {
        const command = FIX_EXECUTOR_COMMANDS[executor];
        const available = await isCommandAvailable(command);

        if (!available) {
          return null;
        }

        return { action, executor, label: FIX_ACTION_LABELS[action] };
      }
    )
  );

  return results.filter(
    (result): result is { action: FixAction; executor: ReviewExecutorName; label: string } =>
      result !== null
  );
}

export async function handleReviewCommand(
  planFile: string | undefined,
  options: any,
  command: any
): Promise<ReviewCommandResult> {
  const isPrintMode = options.print === true;
  const tunnelActive = isTunnelActive();
  const withReviewLogger = <T>(cb: () => T) => {
    if (isPrintMode && !tunnelActive && !headlessAdapter) {
      // In print mode without tunnel or headless: suppress or redirect output to avoid
      // polluting stdout (which the executor captures). When the tunnel is
      // active the adapter installed at tim.ts level already forwards output
      // to the parent process, so we let it handle everything. When headless
      // is active it already wraps the print-mode logger, so no replacement needed.
      const logger = options.verbose ? reviewPrintVerboseLogger : reviewPrintQuietLogger;
      return runWithLogger(logger, cb);
    } else {
      return cb();
    }
  };

  const isInteractiveEnv = !isPrintMode && process.env.TIM_INTERACTIVE !== '0';
  const globalOpts = command.parent.opts();
  let config = getDefaultConfig();
  let completionMessage = '';
  let completionStatus: 'success' | 'error' = 'success';
  let completionErrorMessage: string | undefined;
  let notifyPlan: PlanSchema | undefined;
  let notifyPlanFile: string | undefined;
  let notifyCwd = '';
  let skipNotification = false;
  let appendedTaskCount = 0;
  let headlessAdapter: HeadlessAdapter | undefined;
  const notifyReviewDone = async (
    message: string,
    status: 'success' | 'error',
    errorMessage?: string
  ): Promise<void> => {
    try {
      await sendNotification(config, {
        command: 'review',
        event: 'review_done',
        status,
        message,
        errorMessage,
        cwd: notifyCwd || process.cwd(),
        plan: notifyPlan,
        planFile: notifyPlanFile,
      });
    } catch (err) {
      warn(`Failed to send notification: ${err as Error}`);
    }
  };

  // Helper for conditional logging in print mode
  const reviewLog = (...args: any[]) => {
    if (!isPrintMode) {
      log(...args);
    } else if (options.verbose) {
      console.error(...args);
    }
    // else: suppress in quiet print mode
  };

  // If no planFile is provided, try to auto-select one from branch-specific plans
  let resolvedPlanFile = planFile;
  try {
    try {
      config = await loadEffectiveConfig(globalOpts.config);
    } catch (err) {
      config = await loadGlobalConfigForNotifications(globalOpts.config);
      throw err;
    }

    if (!resolvedPlanFile) {
      let autoSelectedPlan = await findBranchSpecificPlan(globalOpts.config);

      if (!autoSelectedPlan) {
        // Fallback: try to find a single modified plan
        autoSelectedPlan = await findSingleModifiedPlanOnBranch(globalOpts.config);

        if (autoSelectedPlan) {
          reviewLog(
            chalk.cyan(
              `No new plans found on branch. Auto-selected modified plan: ${autoSelectedPlan.id} - ${autoSelectedPlan.title}`
            )
          );
          reviewLog(chalk.gray(`Plan file: ${autoSelectedPlan.filename}`));
        }
      } else {
        reviewLog(
          chalk.cyan(`Auto-selected plan: ${autoSelectedPlan.id} - ${autoSelectedPlan.title}`)
        );
        reviewLog(chalk.gray(`Plan file: ${autoSelectedPlan.filename}`));
      }

      if (!autoSelectedPlan) {
        throw new Error(
          'No plan file specified and no suitable plans found. ' +
            'Please specify a plan file explicitly.'
        );
      }

      resolvedPlanFile = autoSelectedPlan.filename;
    }
    if (!resolvedPlanFile) {
      throw new Error('No plan file resolved for review.');
    }
    const resolvedPlanFilePath = resolvedPlanFile;
    notifyPlanFile = resolvedPlanFilePath;
    // We intentionally manage headless setup/teardown manually here instead of
    // runWithHeadlessAdapterIfEnabled because review needs the adapter lifecycle to span
    // setup/flow/finalization and guarantee destroy() runs before completion notifications.
    // In print mode the headless adapter wraps the print-specific logger so output is
    // both redirected away from stdout AND mirrored to the WebSocket.
    if (!tunnelActive) {
      let planSummary: { id?: number; title?: string } | undefined;
      try {
        const plan = await readPlanFile(resolvedPlanFilePath);
        planSummary = {
          id: plan.id,
          title: plan.title,
        };
      } catch {
        // No-op: missing plan metadata should not block review execution.
      }

      const currentAdapter = getLoggerAdapter();
      if (!(currentAdapter instanceof HeadlessAdapter)) {
        if (isPrintMode) {
          // In print mode, install the print-specific logger first so the headless
          // adapter wraps it — output goes to stderr (or is suppressed) while also
          // being mirrored to the WebSocket.
          const printLogger = options.verbose ? reviewPrintVerboseLogger : reviewPrintQuietLogger;
          headlessAdapter = await runWithLogger(printLogger, () =>
            createHeadlessAdapterForCommand({
              command: 'review',
              config,
              plan: planSummary,
            })
          );
        } else {
          headlessAdapter = await createHeadlessAdapterForCommand({
            command: 'review',
            config,
            plan: planSummary,
          });
        }
      }
    }

    const executeReviewFlow = async (): Promise<void> => {
      // Gather plan context using the shared utility
      const context = await withReviewLogger(() =>
        gatherPlanContext(resolvedPlanFilePath, options, globalOpts)
      );

      // Check if no changes were detected and early return for review
      if (context.noChangesDetected) {
        const nothingMessage =
          options.incremental || options.sinceLastReview
            ? 'No changes detected since last review. Nothing new to review.'
            : 'No changes detected compared to trunk branch. Nothing to review.';
        reviewLog(chalk.yellow(nothingMessage));
        skipNotification = true;
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
      notifyPlan = planData;
      notifyPlanFile = contextPlanFile;

      reviewLog(chalk.green(`Reviewing plan: ${planData.id} - ${planData.title}`));

      // Get git root for the rest of the function (needed for file operations)
      const gitRoot = await getGitRoot();
      notifyCwd = gitRoot;

      // Load custom instructions
      let customInstructions = '';
      let previousReviewResponse: string | undefined;

      // First try CLI options (CLI takes precedence)
      if (options.instructions) {
        customInstructions = options.instructions;
        reviewLog(chalk.gray('Using inline custom instructions from CLI'));
      } else if (options.instructionsFile) {
        try {
          const instructionsPath = validateInstructionsFilePath(options.instructionsFile, gitRoot);
          customInstructions = await readFile(instructionsPath, 'utf-8');
          reviewLog(
            chalk.gray(`Using custom instructions from CLI file: ${options.instructionsFile}`)
          );
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewLog(
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
          reviewLog(
            chalk.gray(
              `Using custom instructions from config: ${config.review.customInstructionsPath}`
            )
          );
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewLog(
            chalk.yellow(
              `Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${errorMessage}`
            )
          );
        }
      }

      if (options.previousResponse) {
        try {
          previousReviewResponse = await readFile(options.previousResponse, 'utf-8');
          reviewLog(
            chalk.gray(`Using previous review response from file: ${options.previousResponse}`)
          );
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewLog(
            chalk.yellow(
              `Warning: Could not read previous review response file: ${options.previousResponse}. ${errorMessage}`
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
          reviewLog(chalk.gray(`Using focus areas from CLI: ${focusAreas.join(', ')}`));
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewLog(chalk.yellow(`Warning: Invalid focus areas from CLI: ${errorMessage}`));
          focusAreas = [];
        }
      } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
        try {
          focusAreas = validateFocusAreas(config.review.focusAreas);
          reviewLog(chalk.gray(`Using focus areas from config: ${focusAreas.join(', ')}`));
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewLog(chalk.yellow(`Warning: Invalid focus areas from config: ${errorMessage}`));
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

      const sharedExecutorOptions: ExecutorCommonOptions = {
        baseDir: gitRoot,
        model: options.model,
        noninteractive: isPrintMode, // Disable permissions prompts in print mode
      };

      const notifyReviewInput = async (message: string): Promise<void> => {
        if (!isInteractiveEnv) {
          return;
        }
        await sendNotification(config, {
          command: 'review',
          event: 'review_input',
          status: 'input',
          message,
          cwd: gitRoot,
          plan: planData,
          planFile: contextPlanFile,
        });
      };

      const {
        planData: scopedPlanData,
        taskScopeNote,
        isScoped,
        remainingTasks,
      } = resolveReviewTaskScope(planData, {
        taskIndex: options.taskIndex,
        taskTitle: options.taskTitle,
      });

      const buildPrompt: ReviewPromptBuilder = ({ includeDiff, useSubagents }) =>
        buildReviewPrompt(
          scopedPlanData,
          diffResult,
          includeDiff,
          useSubagents,
          parentChain,
          completedChildren,
          customInstructions,
          taskScopeNote,
          undefined,
          remainingTasks,
          previousReviewResponse
        );

      // Execute the review
      if (options.dryRun) {
        const prepared = await prepareReviewExecutors({
          executorSelection: options.executor,
          config,
          sharedExecutorOptions,
          buildPrompt,
        });

        log(chalk.cyan('\n## Dry Run - Generated Review Prompt\n'));
        for (const preparedExecutor of prepared) {
          if (prepared.length > 1) {
            log(chalk.cyan(`\n### Executor: ${preparedExecutor.name}\n`));
          }
          log(preparedExecutor.prompt);
        }
        log('\n--dry-run mode: Would execute the above prompt');
        skipNotification = true;
        return;
      }

      sendStructured({
        type: 'review_start',
        timestamp: timestamp(),
        executor: options.executor || config.defaultExecutor,
        planId: planData.id,
      });

      // Execute the review with output capture enabled
      try {
        const planInfo = {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: contextPlanFile,
          baseBranch: diffResult.baseBranch,
          changedFiles: diffResult.changedFiles,
          isTaskScoped: isScoped,
        };

        const runReviewCall = () =>
          runReview({
            executorSelection: options.executor,
            serialBoth: options.serialBoth,
            config,
            sharedExecutorOptions,
            buildPrompt,
            planInfo,
          });

        const reviewOutput = isPrintMode
          ? await withReviewLogger(runReviewCall)
          : await runReviewCall();

        if (reviewOutput.warnings.length > 0) {
          for (const warning of reviewOutput.warnings) {
            warn(chalk.yellow(warning));
          }
        }

        const reviewResult = reviewOutput.reviewResult;
        const rawOutput = reviewOutput.rawOutput;
        const reviewExecutorName = reviewOutput.usedExecutors[0];
        if (!reviewExecutorName) {
          throw new Error('Review completed without a usable executor result.');
        }
        let autofixExecutorName: ReviewExecutorName | null = reviewExecutorName;

        // Determine format and verbosity from options or config
        const outputFormat = isPrintMode
          ? 'json'
          : options.format || config.review?.outputFormat || 'terminal';
        const verbosity: VerbosityLevel = isPrintMode
          ? 'detailed'
          : options.verbosity || 'detailed';

        // Validate format
        if (!['json', 'markdown', 'terminal'].includes(outputFormat)) {
          log(chalk.yellow(`Warning: Invalid format '${outputFormat}', using 'terminal'`));
        }

        // Create formatter options
        const formatterOptions: FormatterOptions = {
          verbosity,
          showFiles: isPrintMode ? true : options.showFiles !== false && verbosity !== 'minimal',
          showSuggestions: isPrintMode ? true : !options.noSuggestions,
          colorEnabled: !options.noColor && outputFormat === 'terminal',
        };

        // Format the review result
        const formatter = createFormatter(
          outputFormat === 'json' || outputFormat === 'markdown' ? outputFormat : 'terminal'
        );
        const formattedOutput = formatter.format(reviewResult, formatterOptions);

        sendStructured({
          type: 'review_result',
          timestamp: timestamp(),
          issues: reviewResult.issues.map((issue) => ({
            severity: issue.severity,
            category: issue.category,
            content: issue.content,
            file: issue.file ?? '',
            line: issue.line != null ? String(issue.line) : '',
            suggestion: issue.suggestion ?? '',
          })),
          recommendations: reviewResult.recommendations,
          actionItems: reviewResult.actionItems,
        });

        // Display formatted output to console
        if (isPrintMode) {
          const outputWithNewline = formattedOutput.endsWith('\n')
            ? formattedOutput
            : `${formattedOutput}\n`;
          if (tunnelActive) {
            // When tunnel is active, write to BOTH:
            // 1. process.stdout directly so the executor can capture it from the child's stdout
            // 2. log() which goes through the tunnel adapter to the parent for display
            process.stdout.write(outputWithNewline);
          }
          log(outputWithNewline);
        } else if (!options.outputFile || outputFormat === 'terminal') {
          log('\n' + formattedOutput);
        }

        // Check if autofix should be performed - with robust issue detection
        const hasIssues = detectIssuesInReview(reviewResult, rawOutput);
        sendStructured({
          type: 'review_verdict',
          timestamp: timestamp(),
          verdict: hasIssues ? 'NEEDS_FIXES' : 'ACCEPTABLE',
          fixInstructions: hasIssues ? reviewResult.actionItems.join('\n') : undefined,
        });
        let shouldAutofix = false;
        let shouldCreateCleanupPlan = false;
        let shouldAppendTasksToPlan = false;
        let selectedIssues: ReviewIssue[] | null = null;

        if (hasIssues && !isPrintMode) {
          if (options.autofix || options.autofixAll) {
            shouldAutofix = true;
            if (!options.autofixAll && reviewResult.issues && reviewResult.issues.length > 0) {
              // Allow selection unless --autofix-all is used
              if (isInteractiveEnv) {
                selectedIssues = await selectIssuesToFix(reviewResult.issues, 'fix', () =>
                  notifyReviewInput('Review needs input: select issues for autofix.')
                );
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
                  'include in cleanup plan',
                  () => notifyReviewInput('Review needs input: select issues for the cleanup plan.')
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
            const availableFixActions = await getAvailableFixActions();
            type ReviewIssueAction = FixAction | 'cleanup' | 'append' | 'exit';
            let action: ReviewIssueAction = 'exit';
            if (isInteractiveEnv) {
              await notifyReviewInput('Review needs input: choose how to proceed with issues.');
              sendStructured({
                type: 'input_required',
                timestamp: timestamp(),
                prompt: 'Choose how to proceed with review issues',
              });
              debugStdinTrace('about to open issue-action prompt');
              try {
                action = await select({
                  message: 'Issues were found during review. What would you like to do?',
                  choices: [
                    { name: 'Append issues to the current plan as tasks', value: 'append' },
                    ...availableFixActions.map((option) => ({
                      name: option.label,
                      value: option.action,
                    })),
                    { name: 'Create a cleanup plan (for later execution)', value: 'cleanup' },
                    { name: 'Exit (do nothing)', value: 'exit' },
                  ],
                  default: 'append',
                });
                debugStdinTrace(`issue-action prompt resolved with action=${action}`);
              } catch (err) {
                const name = err instanceof Error ? err.name : typeof err;
                const message = err instanceof Error ? err.message : String(err);
                debugStdinTrace(`issue-action prompt threw name=${name} message=${message}`);
                throw err;
              }
            } else {
              log(
                chalk.gray('Non-interactive environment detected; skipping fix/cleanup prompts.')
              );
            }

            if (action === 'fix-claude' || action === 'fix-codex') {
              shouldAutofix = true;
              autofixExecutorName = FIX_ACTION_EXECUTOR_MAP[action];
              if (reviewResult.issues && reviewResult.issues.length > 0) {
                selectedIssues = await selectIssuesToFix(reviewResult.issues, 'fix', () =>
                  notifyReviewInput('Review needs input: select issues for autofix.')
                );
                shouldAutofix = selectedIssues.length > 0;
                if (!shouldAutofix) {
                  log(chalk.yellow('No issues selected for autofix.'));
                }
              }
            } else if (action === 'cleanup') {
              // Don't notify at the end because we're just existing right after the user selects the issues
              skipNotification = true;
              shouldCreateCleanupPlan = true;
              if (reviewResult.issues && reviewResult.issues.length > 0) {
                selectedIssues = await selectIssuesToFix(
                  reviewResult.issues,
                  'include in cleanup plan',
                  () => notifyReviewInput('Review needs input: select issues for the cleanup plan.')
                );
                shouldCreateCleanupPlan = selectedIssues.length > 0;
                if (!shouldCreateCleanupPlan) {
                  log(chalk.yellow('No issues selected for cleanup plan.'));
                }
              }
            } else if (action === 'append') {
              // Don't notify at the end because we're just existing right after the user selects the issues
              skipNotification = true;
              shouldAppendTasksToPlan = true;
              if (reviewResult.issues && reviewResult.issues.length > 0) {
                selectedIssues = await selectIssuesToFix(
                  reviewResult.issues,
                  'append as plan tasks',
                  () => notifyReviewInput('Review needs input: select issues to append as tasks.')
                );
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

        if (shouldAppendTasksToPlan && hasIssues && !isPrintMode) {
          const issuesToAppend =
            (selectedIssues && selectedIssues.length > 0 ? selectedIssues : reviewResult.issues) ||
            [];

          if (issuesToAppend.length === 0) {
            log(chalk.yellow('No review issues available to append as tasks.'));
          } else {
            try {
              const appendedCount = await appendIssuesToPlanTasks(contextPlanFile, issuesToAppend);
              appendedTaskCount = appendedCount;

              if (appendedCount > 0) {
                const plural = appendedCount === 1 ? '' : 's';
                log(
                  chalk.green(
                    `✓ Added ${appendedCount} review issue${plural} as task${plural} to plan ${planData.id}.`
                  )
                );
              } else {
                log(chalk.gray('No new tasks were added (likely due to duplicate titles).'));
              }
            } catch (appendErr) {
              const appendMessage =
                appendErr instanceof Error ? appendErr.message : String(appendErr);
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
              reviewLog(chalk.cyan(`Review saved to: ${savedPath}`));

              // Create Git note if requested
              if (options.gitNote) {
                const reviewSummary = `Code review completed for plan ${metadata.planId}: ${metadata.planTitle}`;
                const noteCreated = await createGitNote(gitRoot, currentCommitHash, reviewSummary);
                if (noteCreated) {
                  reviewLog(chalk.cyan('Git note created with review summary'));
                } else {
                  reviewLog(chalk.yellow('Warning: Could not create Git note'));
                }
              }
            } else {
              reviewLog(
                chalk.yellow('Warning: Could not save review - unable to determine commit hash')
              );
            }
          } catch (persistenceErr) {
            const persistenceErrorMessage =
              persistenceErr instanceof Error ? persistenceErr.message : String(persistenceErr);
            reviewLog(
              chalk.yellow(`Warning: Could not save review to history: ${persistenceErrorMessage}`)
            );
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
            reviewLog(
              chalk.yellow(`Warning: Could not prepare save location: ${saveErrorMessage}`)
            );
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
                reviewLog(chalk.gray('Incremental review metadata updated for future reviews'));
              }
            }
          } catch (metadataErr) {
            const metadataErrorMessage =
              metadataErr instanceof Error ? metadataErr.message : String(metadataErr);
            reviewLog(
              chalk.yellow(
                `Warning: Could not store incremental review metadata: ${metadataErrorMessage}`
              )
            );
          }
        }

        // Create cleanup plan if requested
        if (shouldCreateCleanupPlan && hasIssues && planData.id && !isPrintMode) {
          sendStructured({
            type: 'workflow_progress',
            timestamp: timestamp(),
            phase: 'cleanup',
            message: 'Creating cleanup plan',
          });

          try {
            const cleanupScopeNote =
              isScoped && taskScopeNote
                ? taskScopeNote.replace('review', 'cleanup plan')
                : undefined;
            const cleanupOptions: CleanupPlanOptions = {
              priority: options.cleanupPriority || 'medium',
              assign: options.cleanupAssign,
              scopeNote: cleanupScopeNote,
              scopedPlan: isScoped ? scopedPlanData : undefined,
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
                `  Next step: Use "tim generate ${cleanupResult.planId}" or "tim run ${cleanupResult.planId}"`
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
        if (performAutofix && hasIssues && !isPrintMode) {
          sendStructured({
            type: 'workflow_progress',
            timestamp: timestamp(),
            phase: 'autofix',
            message: 'Executing autofix',
          });

          try {
            // Build the autofix prompt with validation
            const autofixPrompt = buildAutofixPrompt(
              scopedPlanData,
              reviewResult,
              diffResult,
              selectedIssues
            );

            // Execute autofix using the executor in normal mode
            const executorName = autofixExecutorName ?? reviewExecutorName;
            const autofixExecutor = buildExecutorAndLog(
              executorName,
              sharedExecutorOptions,
              config
            );

            const autofixOutput = await autofixExecutor.execute(autofixPrompt, {
              planId: planData.id?.toString() ?? 'unknown',
              planTitle: `${planData.title ?? 'Untitled Plan'} - Autofix`,
              planFilePath: contextPlanFile,
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

        reviewLog(chalk.green('\nCode review completed successfully!'));
        completionMessage = 'Review completed successfully.';
        completionStatus = 'success';
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
              chalk.yellow(
                'Hint: Check file permissions and ensure you have access to the repository.'
              )
            );
          } else if (err.message.includes('network')) {
            log(chalk.yellow('Hint: Check your internet connection and API credentials.'));
          }
        }

        completionMessage = `Review failed: ${errorMessage}`;
        completionStatus = 'error';
        completionErrorMessage = errorMessage;
        throw new Error(contextualError);
      }
    };

    if (headlessAdapter) {
      await runWithLogger(headlessAdapter, executeReviewFlow);
    } else {
      await executeReviewFlow();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!completionMessage) {
      completionMessage = `Review failed: ${errorMessage}`;
    }
    completionStatus = 'error';
    completionErrorMessage = errorMessage;
    throw err;
  } finally {
    if (headlessAdapter) {
      try {
        await headlessAdapter.destroy();
      } catch {
        // Headless cleanup should not prevent notifications or mask prior errors.
      }
    }

    if (!skipNotification && completionMessage) {
      await notifyReviewDone(completionMessage, completionStatus, completionErrorMessage);
    }
  }

  return { tasksAppended: appendedTaskCount };
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

type ReviewTaskFilterOptions = {
  taskIndex?: string | string[];
  taskTitle?: string | string[];
};

type RemainingTask = { index: number; title: string };

type ReviewTaskScope = {
  planData: PlanSchema;
  taskScopeNote?: string;
  isScoped: boolean;
  remainingTasks: RemainingTask[];
};

function normalizeTaskFilterInput(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTaskIndexes(value: string | string[] | undefined): {
  indexes: number[];
  invalidTokens: string[];
} {
  const tokens = normalizeTaskFilterInput(value);
  const indexes: number[] = [];
  const invalidTokens: string[] = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed < 1) {
      invalidTokens.push(token);
      continue;
    }
    indexes.push(parsed - 1); // Convert 1-based input to 0-based internal index
  }

  return { indexes, invalidTokens };
}

export function resolveReviewTaskScope(
  planData: PlanSchema,
  options: ReviewTaskFilterOptions
): ReviewTaskScope {
  const { indexes: taskIndexes, invalidTokens } = parseTaskIndexes(options.taskIndex);
  const taskTitles = normalizeTaskFilterInput(options.taskTitle);

  if (taskIndexes.length === 0 && taskTitles.length === 0 && invalidTokens.length === 0) {
    return { planData, isScoped: false, remainingTasks: [] };
  }

  const tasks = planData.tasks ?? [];
  const matchedIndexes = new Set<number>();
  const unknownIndexes: number[] = [];
  const unknownTitles: string[] = [];

  for (const index of taskIndexes) {
    if (index < 0 || index >= tasks.length) {
      unknownIndexes.push(index);
    } else {
      matchedIndexes.add(index);
    }
  }

  const taskTitleMap = tasks.map((task, index) => ({
    index,
    title: task.title.trim().toLowerCase(),
  }));

  for (const title of taskTitles) {
    const normalizedTitle = title.trim().toLowerCase();
    if (!normalizedTitle) {
      continue;
    }

    const matches = taskTitleMap
      .filter((task) => task.title === normalizedTitle)
      .map((task) => task.index);

    if (matches.length === 0) {
      unknownTitles.push(title);
      continue;
    }

    for (const matchIndex of matches) {
      matchedIndexes.add(matchIndex);
    }
  }

  const uniqueUnknownIndexes = Array.from(new Set(unknownIndexes));
  const uniqueInvalidTokens = Array.from(new Set(invalidTokens));
  const uniqueUnknownTitles = Array.from(new Set(unknownTitles));

  if (
    uniqueInvalidTokens.length > 0 ||
    uniqueUnknownIndexes.length > 0 ||
    uniqueUnknownTitles.length > 0
  ) {
    const parts: string[] = [];
    if (uniqueInvalidTokens.length > 0) {
      parts.push(`Invalid task indexes: ${uniqueInvalidTokens.join(', ')}`);
    }
    if (uniqueUnknownIndexes.length > 0) {
      // Convert back to 1-based for user display
      parts.push(`Unknown task indexes: ${uniqueUnknownIndexes.map((i) => i + 1).join(', ')}`);
    }
    if (uniqueUnknownTitles.length > 0) {
      parts.push(`Unknown task titles: ${uniqueUnknownTitles.join(', ')}`);
    }
    throw new Error(parts.join('; '));
  }

  // Preserve original 1-based indexes when filtering tasks
  const filteredTasks: PlanTaskWithIndex[] = tasks
    .map((task, index) => ({ ...task, originalIndex: index + 1 }))
    .filter((_, index) => matchedIndexes.has(index));
  const totalTasks = tasks.length;
  const taskScopeNote = `This review is limited to the tasks listed below (${filteredTasks.length} of ${totalTasks}). Other plan tasks are out of scope.`;

  // Compute remaining unfinished tasks outside the review scope
  const remainingTasks: RemainingTask[] = tasks
    .map((task, index) => ({ index: index + 1, title: task.title, done: task.done }))
    .filter((task) => !matchedIndexes.has(task.index - 1) && !task.done)
    .map(({ index, title }) => ({ index, title }));

  return {
    planData: {
      ...planData,
      tasks: filteredTasks,
    },
    taskScopeNote,
    isScoped: true,
    remainingTasks,
  };
}

/**
 * Prompts the user to select which issues to address from the review results
 * (issues can be either fixed immediately or included in a cleanup plan)
 */
async function selectIssuesToFix(
  issues: ReviewIssue[],
  purpose: string = 'fix',
  notifyInput?: () => Promise<void>
): Promise<ReviewIssue[]> {
  const isInteractiveEnv = process.env.TIM_INTERACTIVE !== '0';
  if (!isInteractiveEnv) {
    return issues;
  }
  if (notifyInput) {
    await notifyInput();
  }
  sendStructured({
    type: 'input_required',
    timestamp: timestamp(),
    prompt: `Select issues to ${purpose}`,
  });
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
    critical: '!!',
    major: '!',
    minor: '-',
    info: 'i',
  };

  for (const severity of severityOrder) {
    const severityIssues = groupedIssues[severity] || [];
    for (const issue of severityIssues) {
      const fileInfo = issue.file ? ` (${issue.file}${issue.line ? ':' + issue.line : ''})` : '';

      const firstLine = issue.content.split('\n')[0];
      let fullDesc = issue.content + fileInfo;
      if (issue.suggestion) {
        fullDesc += `\n\nSuggestion: ${issue.suggestion}`;
      }

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

/** A task with its original 1-based index preserved when filtering */
type PlanTaskWithIndex = PlanTask & { originalIndex?: number };

function buildTaskTitleFromIssue(issue: ReviewIssue): string {
  // Normalize whitespace and get content as a single string
  const normalized = issue.content.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 'Address Review Feedback: Review feedback';
  }

  // Extract the first sentence (ends with . ! or ? followed by space or end of string)
  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[1] : normalized;

  return `Address Review Feedback: ${firstSentence}`;
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
  issues: ReviewIssue[]
): Promise<number> {
  // Re-read the plan to get the latest state (handles parallel reviews)
  const planData = await readPlanFile(planFilePath);

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

/**
 * Builds a review prompt from command-line options, similar to handleReviewCommand
 * but without executing the review. This is used by the prompts command to show
 * what prompt would be generated.
 *
 * @param planFile - Plan file path or ID
 * @param options - Review command options including task filters, instructions, etc.
 * @param globalOpts - Global CLI options including config path
 * @returns Promise<string> containing the generated prompt
 */
export async function buildReviewPromptFromOptions(
  planFile: string,
  options: {
    taskIndex?: string | string[];
    taskTitle?: string | string[];
    instructions?: string;
    instructionsFile?: string;
    focus?: string;
    incremental?: boolean;
    sinceLastReview?: boolean;
    since?: string;
    base?: string;
    previousResponse?: string;
  },
  globalOpts: {
    config?: string;
  }
): Promise<string> {
  // Load config
  const config = await loadEffectiveConfig(globalOpts.config);

  // Gather plan context using the shared utility
  const context = await gatherPlanContext(planFile, options, globalOpts);

  // Extract context
  const { planData, parentChain, completedChildren, diffResult } = context;

  // Get git root for file operations
  const gitRoot = await getGitRoot();

  // Load custom instructions
  let customInstructions = '';
  let previousReviewResponse: string | undefined;

  // First try CLI options (CLI takes precedence)
  if (options.instructions) {
    customInstructions = options.instructions;
  } else if (options.instructionsFile) {
    try {
      const instructionsPath = validateInstructionsFilePath(options.instructionsFile, gitRoot);
      customInstructions = await readFile(instructionsPath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read instructions file from CLI: ${options.instructionsFile}. ${errorMessage}`
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${errorMessage}`
      );
    }
  }

  if (options.previousResponse) {
    try {
      const previousResponsePath = validateInstructionsFilePath(options.previousResponse, gitRoot);
      previousReviewResponse = await readFile(previousResponsePath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read previous review response file: ${options.previousResponse}. ${errorMessage}`
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(`Warning: Invalid focus areas from CLI: ${errorMessage}`);
      focusAreas = [];
    }
  } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
    try {
      focusAreas = validateFocusAreas(config.review.focusAreas);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(`Warning: Invalid focus areas from config: ${errorMessage}`);
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

  // Resolve task scope
  const {
    planData: scopedPlanData,
    taskScopeNote,
    remainingTasks,
  } = resolveReviewTaskScope(planData, {
    taskIndex: options.taskIndex,
    taskTitle: options.taskTitle,
  });

  // Build and return the prompt
  return buildReviewPrompt(
    scopedPlanData,
    diffResult,
    false, // includeDiff - not needed for prompt viewing
    false, // useSubagents - not needed for prompt viewing
    parentChain,
    completedChildren,
    customInstructions,
    taskScopeNote,
    undefined,
    remainingTasks,
    previousReviewResponse
  );
}

export function buildReviewPrompt(
  planData: PlanSchema,
  diffResult: DiffResult,
  includeDiff: boolean = false,
  useSubagents: boolean = false,
  parentChain: PlanWithFilename[] = [],
  completedChildren: PlanWithFilename[] = [],
  customInstructions?: string,
  taskScopeNote?: string,
  additionalContext?: string,
  remainingTasks?: RemainingTask[],
  previousReviewResponse?: string
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

  if (taskScopeNote) {
    planContext.push(`**Review Scope:** ${taskScopeNote}`, ``);
  }

  if (remainingTasks && remainingTasks.length > 0) {
    planContext.push(`**Remaining Unfinished Tasks:**`);
    for (const task of remainingTasks) {
      planContext.push(`- ${task.index}. ${task.title}`);
    }
    planContext.push(
      ``,
      `*Note: The tasks listed above are not yet implemented. Do not flag issues that are clearly expected to be addressed by these remaining tasks.*`,
      ``
    );
  }

  const hasSpecificTasks = planData.tasks?.length;
  if (hasSpecificTasks) {
    planContext.push(`**Tasks:**`);
    planData.tasks.forEach((task, index) => {
      const status = task.done ? '✓' : '○';
      // Use originalIndex if present (for filtered/scoped tasks), otherwise use array index
      const displayIndex = (task as PlanTaskWithIndex).originalIndex ?? index + 1;
      planContext.push(`${status} ${displayIndex}. **${task.title}**`);
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

  const planScope = hasSpecificTasks ? ' of the specified tasks' : '';

  // Combine everything into the final prompt
  const contextContent = [
    ...parentContext,
    ...childrenContext,
    ...planContext,
    ``,
    ...changedFilesSection,
    ``,
    ...(additionalContext?.trim() ? [additionalContext.trim(), ``] : []),
    ...(previousReviewResponse?.trim()
      ? [
          `# Previous Fixer Response`,
          ``,
          `We just ran a round of fixing in response to a previous review. The final output from the fixing work is below. Please conduct a general review${planScope}, taking this fixer output into account:`,
          ``,
          previousReviewResponse.trim(),
          ``,
        ]
      : []),
    `# Review Instructions`,
    ``,
    `Please review the code changes above in the context of the plan requirements. Focus on:`,
    `1. **Compliance with Plan Requirements:** Do the changes fulfill the goals and tasks outlined in the plan?`,
    `2. **Code Quality:** Look for bugs, logic errors, security issues, and performance problems`,
    `3. **Implementation Completeness:** Are all required features implemented according to the plan?`,
    `4. **Error Handling:** Are edge cases and error conditions properly handled?`,
    `5. **Testing:** Are the changes adequately tested?`,
    ``,
    `**Pre-existing Issues:** If you notice concerns in code that was not modified by these changes, they may still be worth noting. However, any pre-existing issues MUST be labeled as "info" severity. Only issues introduced or affected by the current changes should receive higher severity ratings.`,
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
 * Determine if issues exist in the review result
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
  // This is almost never needed now that we are using real structured output
  // in the review commands.
  if (rawOutput && rawOutput.includes('NEEDS_FIXES')) {
    return true;
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
      // Use originalIndex if present (for filtered/scoped tasks), otherwise use array index
      const displayIndex = (task as PlanTaskWithIndex).originalIndex ?? index + 1;
      prompt.push(`${displayIndex}. **${task.title}**`);
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
