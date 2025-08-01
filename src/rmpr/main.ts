/**
 * @fileoverview Main handler for the rmpr command - addresses GitHub Pull Request review comments
 * using Large Language Models. This module integrates with GitHub's API to fetch PR comments,
 * processes them using various LLM execution strategies, and applies the resulting changes.
 *
 * Key responsibilities:
 * - Fetching and parsing GitHub PR review comments
 * - Supporting multiple comment processing modes (inline vs separate context)
 * - Integrating with common utilities for Git operations, file handling, and process management
 * - Managing the end-to-end workflow from comment selection to code changes and PR replies
 *
 * The module leverages the refactored architecture with:
 * - Common GitHub utilities in src/common/github/ for PR operations
 * - Common Git utilities in src/common/git.ts for branch detection and operations
 * - Common process utilities in src/common/process.ts for commits and spawning
 * - Shared file system utilities in src/common/fs.ts for secure file operations
 * - Centralized executor system from src/rmplan/executors/ for LLM integration
 */

import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as path from 'node:path';
import { parseCliArgsFromString } from '../common/cli.js';
import { secureWrite } from '../common/fs.js';
import { getCurrentBranchName, getGitRoot, hasUncommittedChanges } from '../common/git.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import {
  addReplyToReviewThread,
  detectPullRequest,
  fetchPullRequestAndComments,
  selectReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import { askForModelId } from '../common/model_factory.js';
import { commitAll } from '../common/process.js';
import { debugLog, error, log, warn } from '../logging.js';
import { fullRmfilterRun } from '../rmfilter/rmfilter.js';
import type { RmplanConfig } from '../rmplan/configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../rmplan/executors/index.js';
import {
  argsFromRmprOptions,
  combineRmprOptions,
  parseCommandOptionsFromComment,
  type RmprOptions,
} from './comment_options.js';
import { getCurrentCommitSha } from './git_utils.js';
import {
  createHybridContextPrompt,
  formatDiffContexts,
  insertAiCommentsAndPrepareDiffContexts,
} from './modes/hybrid_context.js';
import {
  createInlineCommentsPrompt,
  insertAiCommentsIntoFileContent,
  removeAiCommentMarkers,
} from './modes/inline_comments.js';
import {
  createSeparateContextPrompt,
  formatReviewCommentsForSeparateContext,
} from './modes/separate_context.js';
import type { CommentDiffContext, DetailedReviewComment } from './types.js';

/**
 * Main handler for the rmpr command that processes GitHub Pull Request review comments using LLMs.
 *
 * This function orchestrates the complete workflow of:
 * 1. Detecting and validating the target PR (from argument or current branch)
 * 2. Fetching unresolved review comments from GitHub API
 * 3. Allowing user selection of comments to address
 * 4. Processing comments in either inline or separate context mode
 * 5. Executing LLM-generated responses using the configured executor
 * 6. Committing changes and optionally posting replies to review threads
 *
 * The function integrates extensively with the refactored common utilities:
 * - Uses src/common/github/ for PR detection and comment fetching
 * - Uses src/common/git.ts for branch operations and change detection
 * - Uses src/common/process.ts for commit operations
 * - Uses src/common/fs.ts for secure file writing
 * - Uses src/rmplan/executors/ for LLM execution strategies
 *
 * @param prIdentifierArg - Optional PR identifier (URL, number, or undefined for auto-detection)
 * @param options - Configuration options for execution mode, model, etc.
 * @param globalCliOptions - Global CLI options like debug flags
 * @param config - RmplanConfig instance with user preferences and settings
 * @throws {Error} When PR cannot be identified, GitHub token is missing, or execution fails
 */
export async function handleRmprCommand(
  prIdentifierArg: string | undefined,
  options: {
    executor: string;
    mode: string;
    yes: boolean;
    model?: string;
    dryRun: boolean;
    run: boolean;
    commit: boolean;
    comment: boolean;
  },
  globalCliOptions: { debug?: boolean },
  config: RmplanConfig
) {
  if (!process.env.GITHUB_TOKEN) {
    error(
      'GITHUB_TOKEN environment variable is not set. Please set it to a valid GitHub personal access token.'
    );
    process.exit(1);
  }

  const resolvedPrIdentifier = await detectPullRequest(prIdentifierArg);
  if (!resolvedPrIdentifier) {
    error('Could not identify a PR to process.');
    process.exit(1);
  }

  log(
    `Processing PR: ${resolvedPrIdentifier.owner}/${resolvedPrIdentifier.repo}#${resolvedPrIdentifier.number}`
  );

  // If we autodetected the PR, verify the branch matches
  if (!prIdentifierArg) {
    const currentBranch = await getCurrentBranchName();
    if (currentBranch) {
      const prData = await fetchPullRequestAndComments(
        resolvedPrIdentifier.owner,
        resolvedPrIdentifier.repo,
        resolvedPrIdentifier.number
      );

      if (prData.pullRequest.headRefName !== currentBranch) {
        warn(
          `Warning: Current branch "${currentBranch}" does not match PR branch "${prData.pullRequest.headRefName}".`
        );
        const proceed =
          options.yes ||
          (
            await input({
              message: 'Continue anyway? (y/N)',
              default: 'n',
            })
          ).toLowerCase() === 'y';

        if (!proceed) {
          log('Operation cancelled by user.');
          process.exit(0);
        }
      }
    }
  }

  // Check if PR identifier was explicitly provided (not autodetected)
  const wasPrIdentifierExplicit =
    prIdentifierArg !== undefined && (await parsePrOrIssueNumber(prIdentifierArg)) !== null;

  let prData;
  try {
    log('Fetching PR data and comments...');
    prData = await fetchPullRequestAndComments(
      resolvedPrIdentifier.owner,
      resolvedPrIdentifier.repo,
      resolvedPrIdentifier.number
    );
  } catch (e: any) {
    error(`Failed to fetch PR data: ${e.message}`);
    if (globalCliOptions.debug) {
      console.error(e);
    }
    process.exit(1);
  }

  // Check for branch mismatch if PR identifier was explicitly provided
  if (wasPrIdentifierExplicit) {
    const currentScmBranch = await getCurrentBranchName();
    const prHeadBranch = prData.pullRequest.headRefName;

    if (currentScmBranch && currentScmBranch !== prHeadBranch) {
      warn(
        `Current local branch "${currentScmBranch}" does not match the PR's head branch "${prHeadBranch}".`
      );

      if (!options.yes) {
        const proceed = await confirm({
          message: 'Proceed with this PR anyway?',
          default: true,
        });

        if (!proceed) {
          log('User chose not to proceed due to branch mismatch.');
          process.exit(0);
        }
      }
    }
  }

  const { pullRequest } = prData;

  const baseRefName = pullRequest.baseRefName;
  const headRefName = pullRequest.headRefName;
  const changedFiles: FileNode[] = pullRequest.files.nodes;

  log(`Base branch: ${baseRefName}`);
  log(`Head branch: ${headRefName}`);
  log(`Changed files in PR: ${changedFiles.map((f) => f.path).join(', ')}`);

  const unresolvedReviewThreads = pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved);

  if (unresolvedReviewThreads.length === 0) {
    log('No unresolved review comments found for this PR. Exiting.');
    process.exit(0);
  }

  log(`Found ${unresolvedReviewThreads.length} unresolved threads.`);

  const selectedComments = await selectReviewComments(
    unresolvedReviewThreads,
    pullRequest.number,
    pullRequest.title
  );

  if (selectedComments.length === 0) {
    log('No comments selected by the user. Exiting.');
    process.exit(0);
  }

  log(`Selected ${selectedComments.length} comments to address:`);
  selectedComments.forEach(({ comment, thread }, index) => {
    log(`  ${index + 1}. [${thread.path}:${thread.line ?? 'N/A'}]:`);
    log(`     Body: "${comment.body.split('\n')[0]}..."`);
    log(`     Diff Hunk: "${comment.diffHunk.split('\n')[0]}..."`);
  });

  // 1. Identify unique file paths from selected comments and parse --rmpr options
  const commentsByFilePath = new Map<
    string,
    { comments: DetailedReviewComment[]; options: RmprOptions }
  >();
  selectedComments.forEach((comment) => {
    const commentsForThisFile = commentsByFilePath.get(comment.thread.path) || {
      comments: [],
      options: {},
    };

    const { options: rmprOptions, cleanedComment } = parseCommandOptionsFromComment(
      comment.comment.body
    );
    if (rmprOptions) {
      commentsForThisFile.options = combineRmprOptions(commentsForThisFile.options, rmprOptions);
      debugLog(`Parsed --rmpr options for comment ${comment.comment.id}:`, rmprOptions);
    }

    commentsForThisFile.comments.push({ ...comment, cleanedComment });
    commentsByFilePath.set(comment.thread.path, commentsForThisFile);
  });

  log(`Identified ${commentsByFilePath.size} unique file paths from selected comments.`);

  const gitRoot = await getGitRoot();

  let instructions: string;
  const filesProcessedWithAiComments = new Map<string, string>();

  // Initialize state variables for interactive settings adjustment
  const defaultExecutor = options.executor || config?.defaultExecutor || DEFAULT_EXECUTOR;
  let modelForLlmEdit =
    options.model ||
    config?.models?.answerPr ||
    config?.models?.execution ||
    defaultModelForExecutor(defaultExecutor, 'answerPr');
  let additionalUserRmFilterArgs: string[] = [];

  if (!options.yes && !options.dryRun) {
    log('\nSettings can be adjusted before generating the LLM prompt.');
    if (
      (options.mode === 'inline-comments' || options.mode === 'hybrid') &&
      filesProcessedWithAiComments.size > 0
    ) {
      log(
        'AI comments have been written to the relevant files. You can examine and edit them directly on disk before continuing.'
      );
    }

    const promptResults = await optionsPrompt({
      modelForLlmEdit,
      executor: defaultExecutor,
      commit: options.commit,
      comment: options.comment,
      showCommentOption: true,
      mode: options.mode,
    });
    modelForLlmEdit = promptResults.model;
    options.executor = promptResults.executor;
    options.commit = promptResults.commit;
    options.comment = promptResults.comment;
    options.mode = promptResults.mode;
    additionalUserRmFilterArgs = promptResults.rmfilterOptions;
  }

  const executor = buildExecutorAndLog(
    options.executor,
    {
      baseDir: gitRoot,
      model: modelForLlmEdit,
    },
    config
  );

  if (executor.forceReviewCommentsMode) {
    options.mode = executor.forceReviewCommentsMode;
  }

  if (options.mode === 'inline-comments') {
    log('Preparing context in Inline Comments mode...');
    for (const [filePath, fileInfo] of commentsByFilePath.entries()) {
      const absolutePath = path.resolve(gitRoot, filePath);
      const file = Bun.file(absolutePath);
      const exists = await file.exists();

      if (!exists) {
        warn(`File not found: ${filePath} - skipping AI comment insertion for this file`);
        continue;
      }

      const originalContent = await file.text();
      const { contentWithAiComments, errors } = insertAiCommentsIntoFileContent(
        originalContent,
        fileInfo.comments,
        filePath
      );
      filesProcessedWithAiComments.set(filePath, contentWithAiComments);

      for (const message of errors) {
        error(message);
      }
    }

    if (filesProcessedWithAiComments.size > 0 && !options.dryRun) {
      log('\nAI comments have been prepared in the following files:');
      for (const [filePath, content] of filesProcessedWithAiComments.entries()) {
        log(`  - ${filePath}`);
        try {
          await secureWrite(gitRoot, filePath, content);
        } catch (e: any) {
          error(`Failed to write AI comments to ${filePath}: ${e.message}`);
          process.exit(1);
        }
      }
    } else if (filesProcessedWithAiComments.size > 0 && options.dryRun) {
      log(chalk.bold.yellow('\n--- DRY RUN INFO ---'));
      log(
        chalk.yellow(
          'In AI Comments mode, if not a dry run, AI comments would be written to the following files for your review before generating the final prompt:'
        )
      );
      for (const filePath of filesProcessedWithAiComments.keys()) {
        log(chalk.gray(`  - ${filePath}`));
      }
      log(chalk.red('These files have NOT been modified on disk due to --dry-run.'));

      // Show only the sections with AI comments
      log(chalk.bold.cyan('\n--- AI COMMENT SECTIONS ---'));
      printAiCommentSections(filesProcessedWithAiComments);
    }
    instructions = createInlineCommentsPrompt(filesProcessedWithAiComments.keys().toArray());
  } else if (options.mode === 'hybrid') {
    log('Preparing context in Hybrid Context mode...');

    // Variables to aggregate results from all files
    const fileContentsWithAiComments = new Map<string, string>();
    const allCommentDiffContexts: CommentDiffContext[] = [];

    for (const [filePath, fileInfo] of commentsByFilePath.entries()) {
      const absolutePath = path.resolve(gitRoot, filePath);
      const file = Bun.file(absolutePath);
      const exists = await file.exists();

      if (!exists) {
        warn(`File not found: ${filePath} - skipping AI comment insertion for this file`);
        continue;
      }

      const originalContent = await file.text();
      const { contentWithAiComments, commentDiffContexts, errors } =
        insertAiCommentsAndPrepareDiffContexts(originalContent, fileInfo.comments, filePath);

      // Aggregate results
      fileContentsWithAiComments.set(filePath, contentWithAiComments);
      allCommentDiffContexts.push(...commentDiffContexts);
      filesProcessedWithAiComments.set(filePath, contentWithAiComments);

      // Display errors
      for (const { error: errorMessage } of errors) {
        error(errorMessage);
      }
    }

    // Write modified content to disk
    if (fileContentsWithAiComments.size > 0 && !options.dryRun) {
      log('\nAI comments with diff contexts have been prepared in the following files:');
      for (const [filePath, content] of fileContentsWithAiComments.entries()) {
        log(`  - ${filePath}`);
        try {
          await secureWrite(gitRoot, filePath, content);
        } catch (e: any) {
          error(`Failed to write AI comments to ${filePath}: ${e.message}`);
          process.exit(1);
        }
      }
    } else if (fileContentsWithAiComments.size > 0 && options.dryRun) {
      log(chalk.bold.yellow('\n--- DRY RUN INFO ---'));

      log(chalk.bold.cyan('\n--- AI COMMENT SECTIONS ---'));
      printAiCommentSections(filesProcessedWithAiComments);
      log(chalk.red('These files have NOT been modified on disk due to --dry-run.'));

      // Show diff contexts that would be included
      log(chalk.bold.cyan('\n--- DIFF CONTEXTS TO BE INCLUDED ---'));
      log(formatDiffContexts(allCommentDiffContexts));
    }

    // Generate the final LLM prompt using createHybridContextPrompt
    instructions = createHybridContextPrompt(allCommentDiffContexts);
  } else {
    // Default to "separate-context" mode
    log('Preparing context in Separate Context mode...');
    const formattedComments = formatReviewCommentsForSeparateContext(selectedComments);
    instructions = createSeparateContextPrompt(formattedComments);
  }

  const prepareOptions = executor.prepareStepOptions?.();

  let llmPrompt: string;

  if (prepareOptions?.rmfilter) {
    // Construct rmfilter arguments, incorporating --rmpr options
    let rmFilterArgs: string[] = [
      '--with-diff',
      '--diff-from',
      headRefName,
      '--instructions',
      instructions,
      '--model',
      modelForLlmEdit,
    ];

    // Add files and related options
    for (const [filePath, fileInfo] of commentsByFilePath.entries()) {
      const rmprOptions = fileInfo.options;
      rmFilterArgs.push('--', filePath);
      rmFilterArgs.push(...argsFromRmprOptions(rmprOptions, pullRequest));
    }

    rmFilterArgs.push(...additionalUserRmFilterArgs);

    if (prepareOptions.rmfilterArgs) {
      rmFilterArgs.push('--', ...prepareOptions.rmfilterArgs);
    }

    llmPrompt = await fullRmfilterRun({
      args: rmFilterArgs,
      gitRoot,
      baseDir: gitRoot,
      skipWrite: true,
    });
  } else {
    // TODO This needs some additional work to provide enough context to the model.
    llmPrompt = instructions;
  }

  if (options.dryRun) {
    log(
      chalk.bold.red(
        'Exiting due to --dry-run. No LLM call will be made, and no files will be modified by the LLM.'
      )
    );
    process.exit(0);
  }

  await executor.execute(llmPrompt, {
    planId: 'pr-review',
    planTitle: `PR Review: ${pullRequest.title}`,
    planFilePath: 'N/A',
  });

  if (
    (options.mode === 'inline-comments' || options.mode === 'hybrid') &&
    filesProcessedWithAiComments.size > 0
  ) {
    log('Cleaning up AI comment markers...');
    for (const filePath of filesProcessedWithAiComments.keys()) {
      try {
        const absolutePath = path.resolve(gitRoot, filePath);
        const file = Bun.file(absolutePath);
        const exists = await file.exists();

        if (!exists) {
          warn(
            `File not found when cleaning AI markers: ${filePath} - skipping cleanup for this file`
          );
          continue;
        }

        const currentContentAfterLlm = await file.text();
        const cleanedContent = removeAiCommentMarkers(currentContentAfterLlm, filePath);
        await secureWrite(gitRoot, filePath, cleanedContent);
      } catch (e: any) {
        error(`Failed to clean AI comment markers from ${filePath}: ${e.message}`);
      }
    }
  }

  log('Successfully addressed selected PR comments.');

  if (options.commit) {
    const prUrl = `https://github.com/${resolvedPrIdentifier.owner}/${resolvedPrIdentifier.repo}/pull/${resolvedPrIdentifier.number}`;

    // Check if there are uncommitted changes
    const hasChanges = await hasUncommittedChanges();

    let commitSha: string | null = null;

    if (hasChanges) {
      log('Committing changes...');

      let firstLine: string;
      if (selectedComments.length === 1) {
        const firstCommentBody =
          selectedComments[0].cleanedComment || selectedComments[0].comment.body;
        const bodyFirstLine =
          firstCommentBody.split('\n').find((l) => l.trim().length > 0) || 'Empty comment';
        let slicedBodyFirstLine = bodyFirstLine.slice(0, 50);
        if (slicedBodyFirstLine !== bodyFirstLine) {
          let lastSpace = slicedBodyFirstLine.lastIndexOf(' ');
          if (lastSpace !== -1) {
            slicedBodyFirstLine = slicedBodyFirstLine.slice(0, lastSpace);
          }
          slicedBodyFirstLine += '…';
        }
        firstLine = `Address PR comment: ${slicedBodyFirstLine}`;
      } else {
        firstLine = `Address ${selectedComments.length} PR comments`;
      }
      const commitMessageParts: string[] = [
        firstLine,
        '',
        'Changes address the following review comments:\n',
        selectedComments
          .map((c) => {
            const { thread, comment, cleanedComment } = c;
            const body = cleanedComment || comment.body;
            const url = `${prUrl}#discussion_r${comment.databaseId}`;
            return `## ${thread.path}:${thread.line} -- (${url})\n${body}`;
          })
          .join('\n\n'),
      ];
      const commitMessage = commitMessageParts.join('\n');
      const exitCode = await commitAll(commitMessage);
      if (exitCode === 0) {
        log('Changes committed successfully.');
        commitSha = await getCurrentCommitSha();
      } else {
        error(`Commit failed with exit code ${exitCode}.`);
      }
    } else {
      log('No uncommitted changes detected. Executor appears to have already committed.');
      commitSha = await getCurrentCommitSha();
    }

    // Only post replies if the comment option is enabled and we have a commit SHA
    if (options.comment && commitSha) {
      log('Posting replies to handled review threads...');

      const { owner, repo } = resolvedPrIdentifier;
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;
      const shortSha = commitSha.slice(0, 7);

      for (const { thread } of selectedComments) {
        const replyMessage = `rmplan: Addressed in commit [${shortSha}](${commitUrl}).`;
        const success = await addReplyToReviewThread(thread.id, replyMessage);

        if (success) {
          log(
            `Successfully posted reply to thread ${thread.id} for comment on ${thread.path}:${thread.line ?? 'N/A'}`
          );
        } else {
          debugLog(
            `Failed to post reply to thread ${thread.id} for comment on ${thread.path}:${thread.line ?? 'N/A'}`
          );
        }
      }
    } else if (options.comment && !commitSha) {
      warn('Could not retrieve commit SHA. Skipping posting replies to PR threads.');
    } else {
      debugLog('Skipping posting replies to review threads (--comment not enabled)');
    }
  }

  // Print URLs for all addressed comments
  log('\nAddressed review comments:');
  const prUrl = `https://github.com/${resolvedPrIdentifier.owner}/${resolvedPrIdentifier.repo}/pull/${resolvedPrIdentifier.number}`;
  for (const { thread, comment } of selectedComments) {
    const commentUrl = `${prUrl}#discussion_r${comment.databaseId}`;
    log(`  - ${thread.path}:${thread.line ?? 'N/A'} -- ${commentUrl}`);
  }
}

interface PromptOptions {
  model: string;
  rmfilterOptions: string[];
  executor: string;
  commit: boolean;
  comment: boolean;
  mode: string;
}

async function optionsPrompt(initialOptions: {
  modelForLlmEdit: string;
  executor: string;
  commit: boolean;
  comment?: boolean;
  showCommentOption?: boolean;
  mode: string;
}): Promise<PromptOptions> {
  let result: PromptOptions = {
    model: initialOptions.modelForLlmEdit,
    rmfilterOptions: [],
    executor: initialOptions.executor,
    commit: initialOptions.commit,
    comment: initialOptions.comment ?? false,
    mode: initialOptions.mode,
  };

  let userWantsToContinue = false;
  while (!userWantsToContinue) {
    log('');
    const choice = await select({
      message: 'What would you like to do?',
      default: 'continue',
      choices: [
        { name: `Execute (${result.executor} - ${result.model})`, value: 'continue' },
        { name: 'Change LLM model for editing', value: 'model' },
        { name: `Change comment handling mode (current: ${result.mode})`, value: 'mode' },
        { name: 'Edit rmfilter options for context', value: 'rmfilter' },
        result.commit
          ? { name: 'Disable autocommit', value: 'no-commit' }
          : { name: 'Enable autocommit', value: 'commit' },
        ...(initialOptions.showCommentOption
          ? [
              result.comment
                ? { name: 'Disable review thread replies', value: 'no-comment' }
                : { name: 'Enable review thread replies', value: 'comment' },
            ]
          : []),
      ],
    });

    if (choice === 'continue') {
      userWantsToContinue = true;
    } else if (choice === 'model') {
      const newSetting = await askForModelId();
      if (newSetting) {
        result.executor = newSetting.executor;
        result.model = newSetting.value;
      }
      log(`LLM model for editing set to: ${result.model}`);
    } else if (choice === 'rmfilter') {
      const newArgsStr = await input({
        message: 'Enter additional rmfilter arguments (space-separated):',
        default: result.rmfilterOptions.join(' '),
      });
      result.rmfilterOptions = parseCliArgsFromString(newArgsStr.trim());
      log(`Additional rmfilter args set to: "${result.rmfilterOptions.join(' ')}"`);
    } else if (choice === 'mode') {
      const newMode = await select({
        message: 'Select comment handling mode:',
        default: result.mode,
        choices: [
          {
            name: 'Inline Comments - Insert AI comment markers into code',
            value: 'inline-comments',
          },
          { name: 'Separate Context - Include PR comments in prompt', value: 'separate-context' },
          { name: 'Hybrid Context - Combine both approaches', value: 'hybrid' },
        ],
      });
      result.mode = newMode;
      log(`Comment handling mode set to: ${result.mode}`);
    } else if (choice === 'comment' || choice === 'no-comment') {
      result.comment = choice === 'comment';
    } else if (choice === 'no-commit') {
      result.commit = false;
    } else if (choice === 'commit') {
      result.commit = true;
    }
  }

  debugLog(result);

  return result;
}

function printAiCommentSections(files: Map<string, string>) {
  for (const [filePath, content] of files.entries()) {
    const lines = content.split('\n');
    const sections: { startLine: number; endLine: number; lines: string[] }[] = [];
    let currentSection: { startLine: number; endLine: number; lines: string[] } | null = null;
    let inAiSection = false;

    // Find all AI comment sections
    let inCommentBlock = false;
    let consecutiveAiLines = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const hasAiCommentStart = trimmed.includes('AI_COMMENT_START');
      const hasAiCommentEnd = trimmed.includes('AI_COMMENT_END');
      const hasAiComment = trimmed.includes('AI:');

      if (hasAiCommentStart) {
        // Start of a comment block
        inCommentBlock = true;
        inAiSection = true;
        currentSection = { startLine: i + 1, endLine: i + 1, lines: [line] };
        consecutiveAiLines = 0;
      } else if (inCommentBlock) {
        // Inside a comment block - add all lines until AI_COMMENT_END
        if (currentSection) {
          currentSection.lines.push(line);
          currentSection.endLine = i + 1;

          if (hasAiCommentEnd) {
            // End of comment block
            sections.push(currentSection);
            currentSection = null;
            inAiSection = false;
            inCommentBlock = false;
          }
        }
      } else if (hasAiComment) {
        // Standalone AI: comment (not in a block)
        if (!inAiSection) {
          // Start a new section for consecutive AI: comments
          inAiSection = true;
          currentSection = { startLine: i + 1, endLine: i + 1, lines: [line] };
          consecutiveAiLines = 1;
        } else if (currentSection) {
          // Continue the current AI: section
          currentSection.lines.push(line);
          currentSection.endLine = i + 1;
          consecutiveAiLines++;
        }
      } else if (inAiSection && !inCommentBlock) {
        // Not an AI: comment, but we're in a standalone AI: section
        if (currentSection) {
          // Add one more line after consecutive AI: comments
          currentSection.lines.push(line);
          currentSection.endLine = i + 1;
          sections.push(currentSection);
          currentSection = null;
          inAiSection = false;
          consecutiveAiLines = 0;
        }
      }
    }

    // Add any remaining section
    if (currentSection) {
      sections.push(currentSection);
    }

    // Print the sections
    if (sections.length > 0) {
      log(chalk.bold.green(`\n=== ${filePath} ===`));
      for (const section of sections) {
        log(chalk.blue(`Lines ${section.startLine}-${section.endLine}:`));
        section.lines.forEach((line) => log(line));
        log(chalk.gray('---'));
      }
    }
  }
}
